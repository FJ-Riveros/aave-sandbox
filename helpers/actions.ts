import { AaveOracle } from "./../typechain-types/AaveOracle";
import { MockAggregator__factory } from "./../typechain-types/factories/MockAggregator__factory";
import { IERC20Detailed__factory } from "./../typechain-types/factories/IERC20Detailed__factory";
import { MAX_UINT_AMOUNT } from "./../config/constants";
import { IPriceOracle } from "./../typechain-types/IPriceOracle";
import { ILendingPool } from "./../typechain-types/ILendingPool";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import Bluebird from "bluebird";
import {
  formatTokenBalance,
  getContract,
  getErc20,
  getTokenSymbol,
  impersonateAddress,
  waitForTx,
} from "./utils";
import { BigNumber } from "ethers";
import "./wadraymath";
import { IPermissionManager } from "../typechain-types/IPermissionManager";
import { ARC_WHITELISTER } from "../config/addresses";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { formatEther, formatUnits, parseUnits } from "ethers/lib/utils";
import { IERC20Detailed } from "../typechain-types/IERC20Detailed";

declare var hre: HardhatRuntimeEnvironment;

interface Token {
  symbol: string;
  tokenAddress: string;
}

export const injectLiquidity = async (
  depositors: SignerWithAddress[],
  assets: Token[],
  pool: ILendingPool,
  depositFactor = "10000"
) => {
  await Bluebird.each(depositors, async (depositor) => {
    await Bluebird.each(assets, async ({ tokenAddress }) => {
      const token = await (await getErc20(tokenAddress)).connect(depositor);
      const poolInstance = pool.connect(depositor);

      const balance = await token.balanceOf(depositor.address);
      if (balance.eq("0")) {
        const symbol = await getTokenSymbol(token.address);
        console.log(
          `[Warning] Depositor does not have funds for ${symbol} token`
        );
        return;
      }
      await waitForTx(await token.approve(pool.address, "0"));
      await waitForTx(await token.approve(pool.address, MAX_UINT_AMOUNT));
      await waitForTx(
        await poolInstance.deposit(
          tokenAddress,
          balance.percentMul(depositFactor),
          depositor.address,
          "0"
        )
      );
    });
  });
};

export const borrowFromMarket = async (
  borrowers: SignerWithAddress[],
  borrowableAssets: Token[],
  pool: ILendingPool,
  priceOracle: AaveOracle,
  borrowFactor = "9500"
) => {
  await Bluebird.each(borrowers, async (borrower) => {
    const userGlobalData = await pool.getUserAccountData(borrower.address);
    const divisionAvailableEth = userGlobalData.availableBorrowsETH.div(
      borrowableAssets.length
    );

    await Bluebird.each(borrowableAssets, async ({ tokenAddress }) => {
      const poolInstance = pool.connect(borrower);
      const detailed = (await getContract(
        "IERC20Detailed",
        tokenAddress
      )) as IERC20Detailed;
      const decimals = await detailed.decimals();

      const tokenPrice = await priceOracle.getAssetPrice(tokenAddress);

      const amountToBorrow = parseUnits(
        divisionAvailableEth
          .div(tokenPrice)
          .percentMul(BigNumber.from(borrowFactor))
          .toString(),
        decimals
      );

      await waitForTx(
        await poolInstance.borrow(
          tokenAddress,
          amountToBorrow,
          "2",
          "0",
          borrower.address
        )
      );
    });
  });
};

export const addPermissions = async (
  permissionsManager: IPermissionManager,
  roles: string[],
  users: string[]
) => {
  // Impersonate Whitelister and set balance to 100 ETH
  const impersonatedOwner = await impersonateAddress(ARC_WHITELISTER);
  await hre.network.provider.send("hardhat_setBalance", [
    ARC_WHITELISTER,
    "0x56BC75E2D63100000",
  ]);

  await Bluebird.each(roles, async (role) => {
    await waitForTx(
      await permissionsManager
        .connect(impersonatedOwner)
        .addPermissions(Array(users.length).fill(role), users)
    );
  });
};

export const formatHealthFactor = (health: BigNumber) => {
  let healthFactor = "UNDEFINED";
  if (health.lt(MAX_UINT_AMOUNT)) {
    healthFactor = formatUnits(health, "18");
  } else if (health.eq(MAX_UINT_AMOUNT)) {
    healthFactor = "MAX";
  }
  return healthFactor;
};

export const printHealthFactor = async (
  users: string[],
  pool: ILendingPool
) => {
  const userToHf = await Bluebird.map(users, async (user) => {
    const accountData = await pool.getUserAccountData(user);
    const healthFactor = formatHealthFactor(accountData.healthFactor);

    return {
      user,
      healthFactor,
    };
  });
  console.table(userToHf);
};

export const replaceOracleSources = async (
  priceFactor: string,
  tokens: string[],
  priceOracle: AaveOracle
) => {
  const [from] = await hre.getUnnamedAccounts();
  const priceOracleMocks = await Bluebird.map(
    tokens,
    async (token) => {
      const priceInQuoteCurrency = (
        await priceOracle.getAssetPrice(token)
      ).percentMul(priceFactor);
      return (
        await hre.deployments.deploy(`MockAggregator-${token}`, {
          contract: "MockAggregator",
          from,
          args: [priceInQuoteCurrency],
        })
      ).address;
    },
    { concurrency: 1 }
  );
  const owner = await impersonateAddress(await priceOracle.owner());
  await hre.network.provider.send("hardhat_setBalance", [
    await owner.getAddress(),
    "0x56BC75E2D63100000",
  ]);
  await waitForTx(
    await priceOracle.connect(owner).setAssetSources(tokens, priceOracleMocks)
  );
};

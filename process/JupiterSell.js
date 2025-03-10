import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import fetch from "cross-fetch";
import * as fs from "fs";
import dotenv from "dotenv";

dotenv.config();

// Environment variable getters
const getInputMint = () => process.env.TOKEN_MINT_ADDRESS;
const getSlippageBps = () => parseInt(process.env.SLIPPAGE_BPS) || 1000;
const getPercentageSell = () => parseFloat(process.env.PERCENTAGE_SELL);
const getInitialBalance = () =>
  parseInt(process.env.INITIAL_BALANCE) * Math.pow(10, 9);
const getRpcEndpoint = () => process.env.HELIUS_RPC_URL;
const getWalletFile = () => process.env.WALLET_FILE;

// Constants that don't need to be dynamic
const OUTPUT_MINT = "So11111111111111111111111111111111111111112"; // Native SOL address
const DECIMALS = 6; // Token decimals

// Get keypair from JSON file
function getKeypairFromFile() {
  const walletPath = getWalletFile();
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file ${walletPath} not found`);
  }
  const privateKeyArray = Uint8Array.from(
    JSON.parse(fs.readFileSync(walletPath, "utf-8"))
  );
  return Keypair.fromSecretKey(privateKeyArray);
}

async function getWalletBalance(connection, publicKey) {
  try {
    const balance = await connection.getBalance(publicKey);
    return balance;
  } catch (error) {
    console.error("Error getting wallet balance:", error);
    throw error;
  }
}

async function getTokenBalance(connection, mintAddress, ownerPublicKey) {
  try {
    const response = await connection.getTokenAccountsByOwner(ownerPublicKey, {
      mint: new PublicKey(mintAddress),
    });
    if (response.value.length === 0) {
      throw new Error("Token account not found");
    }
    const tokenAccountInfo = response.value[0].account.data;
    const amountBuffer = Buffer.from(tokenAccountInfo);
    const amount = amountBuffer.readBigUInt64LE(64);
    return Number(amount);
  } catch (error) {
    console.error("Error getting token balance:", error);
    throw error;
  }
}

async function getQuote(amount) {
  try {
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${getInputMint()}&outputMint=${OUTPUT_MINT}&amount=${amount}&slippageBps=${getSlippageBps()}`;
    const response = await fetch(quoteUrl);
    const quote = await response.json();
    if (!quote || quote.error) {
      console.error("Failed to get quote:", quote?.error);
      return null;
    }
    return quote;
  } catch (error) {
    console.error("Error fetching quote:", error);
    return null;
  }
}

async function getSwapTransaction(quoteResponse, userPublicKey) {
  try {
    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    });
    const swapData = await swapResponse.json();
    if (!swapData || swapData.error) {
      console.error("Failed to get swap transaction:", swapData?.error);
      return null;
    }
    return swapData.swapTransaction;
  } catch (error) {
    console.error("Error fetching swap transaction:", error);
    return null;
  }
}

async function executeTransaction(swapTransaction, keypair, connection) {
  try {
    const swapTxBuffer = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTxBuffer);
    transaction.sign([keypair]);
    const txid = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    console.log(`\x1b[33mTransaction sent: ${txid}\x1b[0m`);
    const latestBlockHash = await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction({
      signature: txid,
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
    });
    if (confirmation.value.err) {
      console.error("Transaction failed:", confirmation.value.err);
      return null;
    }
    console.log(`\x1b[33mSell transaction confirmed: ${txid}\x1b[0m`);
    return txid;
  } catch (error) {
    console.error("Error executing transaction:", error);
    return null;
  }
}

async function processJupiterSell(config) {
  try {
    const connection = new Connection(getRpcEndpoint(), "confirmed");
    const keypair = getKeypairFromFile();
    const walletPublicKey = keypair.publicKey;

    // Get total token balance
    const totalTokenBalance = await getTokenBalance(
      connection,
      getInputMint(),
      walletPublicKey
    );
    console.log(
      `\x1b[33mTotal token balance: ${(
        totalTokenBalance / Math.pow(10, DECIMALS)
      ).toFixed(DECIMALS)} tokens\x1b[0m`
    );

    // Calculate available balance (total minus initial balance to keep)
    const keepBalance = getInitialBalance();
    const availableBalance = Math.max(0, totalTokenBalance - keepBalance);
    console.log(
      `\x1b[33mAvailable balance (after keeping ${
        keepBalance / Math.pow(10, DECIMALS)
      }): ${(availableBalance / Math.pow(10, DECIMALS)).toFixed(
        DECIMALS
      )} tokens\x1b[0m`
    );

    const solBalance = await getWalletBalance(connection, walletPublicKey);
    console.log(
      `\x1b[33mCurrent SOL balance: ${solBalance / LAMPORTS_PER_SOL} SOL\x1b[0m`
    );

    // Calculate amount to sell based on available balance
    let amountToSell = 0;

    if (availableBalance <= 0) {
      console.log(
        `\x1b[33mNo tokens available to sell after keeping initial balance. Skipping sale.\x1b[0m`
      );
      return 0; // Return 0 SOL received
    }

    if (getPercentageSell() > 0 && getPercentageSell() <= 100) {
      amountToSell = Math.floor((availableBalance * getPercentageSell()) / 100);
      if (amountToSell <= 0) {
        console.log(
          `\x1b[33mInsufficient available token balance for the specified percentage. Skipping sale.\x1b[0m`
        );
        return 0; // Return 0 SOL received
      }
      console.log(
        `\x1b[33mSelling ${getPercentageSell()}% of available balance\x1b[0m`
      );
    } else if (config.sellAll) {
      amountToSell = availableBalance;
      console.log(`\x1b[33mSelling all available tokens\x1b[0m`);
    } else {
      amountToSell =
        config.amount || Math.floor(0.0001 * Math.pow(10, DECIMALS));
      if (amountToSell > availableBalance) {
        console.log(
          `\x1b[33mSpecified amount exceeds available token balance. Selling maximum available: ${(
            availableBalance / Math.pow(10, DECIMALS)
          ).toFixed(DECIMALS)} tokens\x1b[0m`
        );
        amountToSell = availableBalance;
      }
    }

    // If we have no tokens to sell after all calculations, return 0
    if (amountToSell <= 0) {
      console.log(`\x1b[33mNo tokens available to sell. Skipping sale.\x1b[0m`);
      return 0;
    }

    console.log(
      `\x1b[33mAmount to sell: ${(
        amountToSell / Math.pow(10, DECIMALS)
      ).toFixed(DECIMALS)} tokens\x1b[0m`
    );

    const quoteResponse = await getQuote(amountToSell);
    if (!quoteResponse) {
      throw new Error("Failed to get quote");
    }

    const swapTransaction = await getSwapTransaction(
      quoteResponse,
      walletPublicKey.toString()
    );
    if (!swapTransaction) {
      throw new Error("Failed to get swap transaction");
    }

    const txid = await executeTransaction(swapTransaction, keypair, connection);
    if (!txid) {
      throw new Error("Failed to execute transaction");
    }

    const finalTokenBalance = await getTokenBalance(
      connection,
      getInputMint(),
      walletPublicKey
    );
    const finalSolBalance = await getWalletBalance(connection, walletPublicKey);
    console.log(`\x1b[33mTransaction successful!\x1b[0m`);
    console.log(
      `\x1b[33mFinal token balance: ${(
        finalTokenBalance / Math.pow(10, DECIMALS)
      ).toFixed(DECIMALS)} tokens\x1b[0m`
    );
    console.log(
      `\x1b[33mFinal SOL balance: ${
        finalSolBalance / LAMPORTS_PER_SOL
      } SOL\x1b[0m`
    );

    // Return the amount of SOL received from the quote
    return quoteResponse.outAmount / LAMPORTS_PER_SOL;
  } catch (error) {
    // Log the error but don't throw it, instead return 0 to indicate no SOL received
    console.error(
      `\x1b[33mError processing sell: ${
        error instanceof Error ? error.message : "Unknown error"
      }\x1b[0m`
    );
    return 0; // Don't propagate the error, just return 0 SOL received
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    sellAll: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--sell-all":
        config.sellAll = true;
        break;
      case "--amount":
        const amount = parseFloat(args[i + 1]);
        if (isNaN(amount)) {
          throw new Error("Invalid amount specified");
        }
        config.amount = Math.floor(amount * Math.pow(10, DECIMALS));
        i++;
        break;
    }
  }
  return config;
}

export default async function sellmain() {
  try {
    const config = parseArgs();
    const solReceived = await processJupiterSell(config);
    return solReceived;
  } catch (error) {
    console.error(
      "Error:",
      error instanceof Error ? error.message : "Unknown error"
    );
    process.exit(1);
  }
}

async function testSellMain() {
  const solReceived = await sellmain();
  console.log(`\x1b[33mSOL received from sale: ${solReceived} SOL\x1b[0m`);
  return solReceived;
}
// testSellMain();

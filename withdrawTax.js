"use strict";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  unpackAccount,
  getTransferFeeAmount,
  withdrawWithheldTokensFromAccounts,
} from "@solana/spl-token";
import { readFileSync, existsSync } from "fs";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Configuration
const RPC_ENDPOINT = process.env.HELIUS_RPC_URL;
const DATA_FILE = process.env.DATA_FILE || "data.json";
const connection = new Connection(RPC_ENDPOINT, "confirmed");

// Configuration for batch processing
const BATCH_SIZE = 20; // Maximum number of accounts to process in one transaction

// Helper function to import keypair data from JSON
function importKeypair(name) {
  if (!existsSync(DATA_FILE)) {
    throw new Error(`File ${DATA_FILE} does not exist.`);
  }
  const data = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  const keypairData = data[name];
  if (!keypairData) {
    throw new Error(`Keypair for ${name} not found in ${DATA_FILE}.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(keypairData.secretKey));
}

// Helper function to chunk array into batches
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Helper function to generate explorer URL
function generateExplorerTxUrl(txId) {
  const network = RPC_ENDPOINT.includes("devnet")
    ? "devnet"
    : RPC_ENDPOINT.includes("testnet")
    ? "testnet"
    : "mainnet";
  return `https://solscan.io/tx/${txId}?cluster=${network}`;
}

async function main() {
  // Import existing keypairs
  const taxCollector = importKeypair("taxCollector");
  const mintKeypair = importKeypair("mint");

  // Check tax collector's SOL balance
  const balance = await connection.getBalance(taxCollector.publicKey);
  console.log(`Tax collector balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  //   if (balance < 0.1 * LAMPORTS_PER_SOL) {
  //     console.error("Tax collector needs at least 0.1 SOL for transactions");
  //     return;
  //   }

  // Create fee vault account if it doesn't exist
  console.log("Creating/checking fee vault account...");
  const feeVaultAccount = await createAssociatedTokenAccountIdempotent(
    connection,
    taxCollector,
    mintKeypair.publicKey,
    taxCollector.publicKey,
    {},
    TOKEN_2022_PROGRAM_ID
  );
  console.log("Fee vault account:", feeVaultAccount.toString());

  // Fetch Fee Accounts
  console.log("Fetching accounts with withheld fees...");
  const allAccounts = await connection.getProgramAccounts(
    TOKEN_2022_PROGRAM_ID,
    {
      commitment: "confirmed",
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: mintKeypair.publicKey.toString(),
          },
        },
      ],
    }
  );

  const accountsToWithdrawFrom = [];
  for (const accountInfo of allAccounts) {
    const account = unpackAccount(
      accountInfo.pubkey,
      accountInfo.account,
      TOKEN_2022_PROGRAM_ID
    );
    const transferFeeAmount = getTransferFeeAmount(account);
    if (
      transferFeeAmount !== null &&
      transferFeeAmount.withheldAmount > BigInt(0)
    ) {
      accountsToWithdrawFrom.push(accountInfo.pubkey);
    }
  }

  if (accountsToWithdrawFrom.length === 0) {
    console.log("No accounts found with withheld fees.");
    return;
  }

  console.log(
    `Found ${accountsToWithdrawFrom.length} accounts with withheld fees`
  );

  // Split accounts into batches
  const batches = chunkArray(accountsToWithdrawFrom, BATCH_SIZE);
  console.log(
    `Processing in ${batches.length} batch(es) of up to ${BATCH_SIZE} accounts each`
  );

  // Process each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(
      `Processing batch ${i + 1} of ${batches.length} (${
        batch.length
      } accounts)...`
    );
    try {
      const withdrawSig = await withdrawWithheldTokensFromAccounts(
        connection,
        taxCollector,
        mintKeypair.publicKey,
        feeVaultAccount,
        taxCollector,
        [],
        batch
      );
      console.log(
        `Batch ${i + 1} complete:`,
        generateExplorerTxUrl(withdrawSig)
      );
    } catch (error) {
      console.error(`Error processing batch ${i + 1}:`, error);
      // Continue with next batch even if this one failed
    }
  }
  console.log("Fee collection complete!");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

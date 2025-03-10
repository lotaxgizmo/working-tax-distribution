import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  Connection,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import BN from "bn.js";
import MongoManager from "./mongoManager.js";
import SolanaManager from "./solanaManager.js";

const IDL = {
  version: "0.1.0",
  name: "sol_distribution",
  instructions: [
    {
      name: "distributeByPercentage",
      accounts: [
        { name: "fundingAccount", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "totalAmount", type: "u64" },
        { name: "percentages", type: { vec: "u32" } },
      ],
    },
  ],
};

const PROGRAM_ID = new PublicKey(
  "75VwsLZCFLbPsdfMAHs12AUtjy4Q9P48ESVLiUbEPE29"
);

const solToLamports = (sol) => Math.floor(sol * 1_000_000_000);

async function sendWithRetry(
  connection,
  serializedTx,
  options,
  maxRetries = 25
) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      const signature = await connection.sendRawTransaction(
        serializedTx,
        options
      );
      return signature;
    } catch (error) {
      if (error.message.includes("429")) {
        const delay = Math.min(500 * Math.pow(2, retries), 10000);
        console.log(
          `\x1b[95mServer responded with 429. Retrying (${
            retries + 1
          }/${maxRetries}) after ${delay}ms...\x1b[0m`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        retries++;
      } else {
        throw error;
      }
    }
  }
  throw new Error(
    `Max retries (${maxRetries}) exceeded for sending transaction`
  );
}

async function batchDistribute(program, totalAmount, recipientShares) {
  const batchSize = 10;
  const connection = program.provider.connection;
  const wallet = program.provider.wallet;

  const MIN_PRIORITY_FEE_MICRO_LAMPORTS = 80_000;
  const recentFees = await connection.getRecentPrioritizationFees();
  const medianFee =
    recentFees.length > 0
      ? recentFees[Math.floor(recentFees.length / 2)].prioritizationFee
      : MIN_PRIORITY_FEE_MICRO_LAMPORTS;
  const priorityFeeMicroLamports = Math.max(80_000, medianFee * 1.5);

  console.log(
    `\x1b[95mMedian fee: ${medianFee}, Using priority fee: ${priorityFeeMicroLamports} microLamports\x1b[0m`
  );

  const numBatches = Math.ceil(recipientShares.length / batchSize);
  const blockhashPromises = Array(numBatches)
    .fill(null)
    .map(() => connection.getLatestBlockhash("confirmed"));
  const blockhashData = await Promise.all(blockhashPromises);
  const blockhashes = blockhashData.map((b) => ({
    blockhash: b.blockhash,
    lastValidBlockHeight: b.lastValidBlockHeight,
  }));

  const signaturePromises = [];
  for (let i = 0; i < recipientShares.length; i += batchSize) {
    const batchIndex = i / batchSize;
    const batch = recipientShares.slice(i, i + batchSize);
    const recipients = batch.map((share) => share.recipient);
    const percentages = batch.map((share) =>
      Math.floor(share.percentage * 100)
    );
    const { blockhash, lastValidBlockHeight } = blockhashes[batchIndex];

    const instruction = await program.methods
      .distributeByPercentage(new BN(totalAmount), percentages)
      .accounts({
        fundingAccount: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        recipients.map((recipient) => ({
          pubkey: recipient,
          isWritable: true,
          isSigner: false,
        }))
      )
      .instruction();

    const transaction = new Transaction({
      recentBlockhash: blockhash,
      feePayer: wallet.publicKey,
    });

    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeMicroLamports,
      })
    );
    transaction.add(instruction);

    const signedTx = await wallet.signTransaction(transaction);
    const signaturePromise = sendWithRetry(connection, signedTx.serialize(), {
      skipPreflight: true,
      preflightCommitment: "confirmed",
    }).then(async (signature) => {
      await connection.confirmTransaction(
        {
          signature,
          blockhash,
          lastValidBlockHeight,
        },
        "confirmed"
      );
      return signature;
    });
    signaturePromises.push(signaturePromise);
  }

  const results = await Promise.allSettled(signaturePromises);
  const successful = [];
  const failed = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      successful.push(result.value);
    } else {
      failed.push({
        index,
        error: result.reason?.message || "Unknown error",
      });
    }
  });
  return { successful, failed };
}

export async function distributeMain(soldAmount) {
  try {
    const solanaManager = await SolanaManager.getInstance();
    const provider = solanaManager.getProvider();
    const program = new Program(IDL, PROGRAM_ID, provider);

    const mongoManager = await MongoManager.getInstance();
    const collection = mongoManager.getCollection(
      process.env.MONGODB_COLLECTION
    );
    console.log(
      `[${new Date().toISOString()}] \x1b[95mFetching recipients from MongoDB...\x1b[0m`
    );
    const recipientsData = await collection.find({}).toArray();
    console.log(
      `[${new Date().toISOString()}] \x1b[95mRetrieved ${
        recipientsData.length
      } recipients\x1b[0m`
    );

    if (!recipientsData || recipientsData.length === 0) {
      throw new Error("No recipients found in MongoDB collection");
    }

    const recipientShares = recipientsData
      .filter((doc) => {
        if (!doc.address || typeof doc.address !== "string") {
          console.warn(
            `[${new Date().toISOString()}] \x1b[93mInvalid address in doc: ${JSON.stringify(
              doc
            )}\x1b[0m`
          );
          return false;
        }
        if (typeof doc.percentage !== "number") {
          console.warn(
            `[${new Date().toISOString()}] \x1b[93mInvalid percentage in doc: ${JSON.stringify(
              doc
            )}\x1b[0m`
          );
          return false;
        }
        return true;
      })
      .map((doc) => {
        try {
          return {
            recipient: new PublicKey(doc.address),
            percentage: doc.percentage,
          };
        } catch (error) {
          console.warn(
            `[${new Date().toISOString()}] \x1b[93mFailed to parse address ${
              doc.address
            }:\x1b[0m`,
            error
          );
          return null;
        }
      })
      .filter((share) => share !== null);

    if (recipientShares.length === 0) {
      throw new Error("No valid recipients found after processing");
    }

    console.log(
      `[${new Date().toISOString()}] \x1b[95mFound ${
        recipientShares.length
      } valid recipients in MongoDB\x1b[0m`
    );
    console.log(
      `[${new Date().toISOString()}] \x1b[95mDistributing ${soldAmount} SOL\x1b[0m`
    );
    console.log(
      `[${new Date().toISOString()}] \x1b[95mStarting SOL distribution...\x1b[0m`
    );

    const lamports = solToLamports(soldAmount);
    const { successful, failed } = await batchDistribute(
      program,
      lamports,
      recipientShares
    );

    console.log(
      `[${new Date().toISOString()}] \x1b[95mDistribution completed!\x1b[0m`
    );
    console.log(
      `[${new Date().toISOString()}] \x1b[95mTotal successful transactions: ${
        successful.length
      }\x1b[0m`
    );
    console.log(
      `[${new Date().toISOString()}] \x1b[95mTotal failed transactions: ${
        failed.length
      }\x1b[0m`
    );

    if (successful.length > 0) {
      console.log(
        `[${new Date().toISOString()}] \x1b[95mSuccessful Transactions:\x1b[0m`
      );
      successful.forEach((sig, i) => {
        console.log(
          `[${new Date().toISOString()}] \x1b[95mTransaction ${
            i + 1
          } signature: https://solscan.io/tx/${sig}?cluster=mainnet\x1b[0m`
        );
      });
    }

    if (failed.length > 0) {
      console.log(`\n[${new Date().toISOString()}] Failed Transactions:`);
      failed.forEach(({ index, error }) => {
        console.log(
          `[${new Date().toISOString()}] Batch ${
            index + 1
          } failed with error: ${error}`
        );
      });
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] \x1b[31mDistribution error: ${
        error.message
      }\x1b[0m`
    );
    console.error(
      `[${new Date().toISOString()}] \x1b[31mError stack:\x1b[0m`,
      error.stack
    );
    throw error;
  }
}

// distributeMain(0.000001);

export { batchDistribute, solToLamports };

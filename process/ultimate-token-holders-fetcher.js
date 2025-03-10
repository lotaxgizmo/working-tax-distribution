import fetch from "cross-fetch";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs/promises";
import { getMint } from "@solana/spl-token";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import cron from "node-cron";
import { fileURLToPath } from "url";

dotenv.config();

// Environment variable getters
const getMongoConfig = () => ({
  uri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB_NAME,
  collectionName: process.env.MONGODB_COLLECTION,
});

const getHeliusConfig = () => ({
  rpcUrl: process.env.HELIUS_RPC_URL,
});

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

// MongoDB setup (only for standalone runs)
let mongoClient;
let db;
let collection;

async function initializeMongoDB() {
  if (!mongoClient) {
    mongoClient = new MongoClient(getMongoConfig().uri);
    await mongoClient.connect();
    db = mongoClient.db(getMongoConfig().dbName);
    collection = db.collection(getMongoConfig().collectionName);
  }
}

/**
 * Determine which token program a mint uses and get its info
 */
async function getTokenProgramAndMint(connection, tokenMint) {
  try {
    try {
      const mintInfo = await getMint(
        connection,
        new PublicKey(tokenMint),
        "confirmed",
        TOKEN_PROGRAM_ID
      );
      return { programId: TOKEN_PROGRAM_ID, mintInfo };
    } catch (error) {
      const mintInfo = await getMint(
        connection,
        new PublicKey(tokenMint),
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      );
      return { programId: TOKEN_2022_PROGRAM_ID, mintInfo };
    }
  } catch (error) {
    console.error("Error determining token program:", error);
    throw error;
  }
}

/**
 * Fetch SOL balances in batches
 */
async function getBatchedSolBalances(connection, pubkeys, batchSize = 100) {
  const balances = new Array(pubkeys.length).fill(0);
  for (let i = 0; i < pubkeys.length; i += batchSize) {
    const batch = pubkeys.slice(i, i + batchSize);
    try {
      const accounts = await connection.getMultipleAccountsInfo(
        batch,
        "confirmed"
      );
      accounts.forEach((account, idx) => {
        balances[i + idx] = account ? account.lamports / 1e9 : 0;
      });
      console.log(
        `Fetched SOL balances for batch ${i / batchSize + 1} (${
          batch.length
        } accounts)`
      );
    } catch (error) {
      console.error(`Error fetching batch ${i / batchSize + 1}:`, error);
      batch.forEach((_, idx) => (balances[i + idx] = 0));
    }
  }
  return balances;
}

/**
 * Fetch all token accounts for a given mint address
 */
async function getTokenHolders(tokenMint) {
  const connection = new Connection(getHeliusConfig().rpcUrl, "confirmed");
  const t1 = Date.now();

  try {
    const { programId, mintInfo } = await getTokenProgramAndMint(
      connection,
      tokenMint
    );
    const totalSupply = Number(mintInfo.supply) / 10 ** mintInfo.decimals;

    console.log(`Total Supply: ${totalSupply.toLocaleString()} tokens`);
    console.log(`Using program: ${programId.toString()}`);

    let tokenAccounts;
    if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
      tokenAccounts = await connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 0, bytes: tokenMint } }],
      });
    } else {
      tokenAccounts = await connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        filters: [
          { dataSize: 165 },
          { memcmp: { offset: 0, bytes: tokenMint } },
        ],
      });
    }

    console.log(`Found ${tokenAccounts.length} token accounts`);

    const holders = tokenAccounts.map((account) => {
      const data = account.account.data;
      const owner = new PublicKey(data.slice(32, 64)).toBase58();
      const balance =
        Number(data.readBigUInt64LE(64)) / 10 ** mintInfo.decimals;
      const percentage = (balance / totalSupply) * 100;
      return { owner, balance, percentage: parseFloat(percentage.toFixed(6)) };
    });

    const nonZeroHolders = holders.filter((holder) => holder.balance > 0);
    console.log(`Filtered to ${nonZeroHolders.length} non-zero holders`);

    const holderPubkeys = nonZeroHolders.map((h) => new PublicKey(h.owner));
    const solBalances = await getBatchedSolBalances(
      connection,
      holderPubkeys,
      100
    );
    const holdersWithSol = nonZeroHolders.map((holder, i) => ({
      ...holder,
      solBalance: solBalances[i],
    }));

    const nonZeroSolHolders = holdersWithSol.filter(
      (holder) => holder.solBalance > 0
    );
    console.log(
      `Filtered to ${nonZeroSolHolders.length} holders with non-zero SOL balances`
    );

    console.log(`getTokenHolders took ${(Date.now() - t1) / 1000}s`);
    return { totalSupply, holders: nonZeroSolHolders };
  } catch (error) {
    console.error("Error fetching token holders:", error);
    throw error;
  }
}

/**
 * Save holders data to MongoDB
 */
async function saveToMongoDB(data) {
  const t1 = Date.now();
  try {
    const holderRecords = data.holders.map((holder) => ({
      address: holder.owner,
      balance: Number(holder.balance.toFixed(9)),
      percentage: Number(holder.percentage.toFixed(6)),
      solBalance: Number(holder.solBalance.toFixed(9)),
    }));

    if (holderRecords.length > 0) {
      await collection.bulkWrite(
        holderRecords.map((record) => ({
          updateOne: {
            filter: { address: record.address },
            update: { $set: record },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    }

    console.log("Data saved to MongoDB successfully");
    console.log(`saveToMongoDB took ${(Date.now() - t1) / 1000}s`);
  } catch (error) {
    console.error("MongoDB Error:", error);
    throw error;
  }
}

/**
 * Fetch holders from MongoDB
 */
async function fetchFromMongoDB() {
  const t1 = Date.now();
  try {
    const holderRecords = await collection
      .find({ solBalance: { $gt: 0 } })
      .toArray();
    console.log("Data fetched from MongoDB successfully");
    console.log(`fetchFromMongoDB took ${(Date.now() - t1) / 1000}s`);
    return holderRecords;
  } catch (error) {
    console.error("MongoDB Fetch Error:", error);
    throw error;
  }
}

/**
 * Main function
 */
export default async function main(tokenMint, options = { exportJson: false }) {
  console.log(`Fetching holders for token: ${tokenMint}`);
  const startTime = Date.now();

  try {
    await initializeMongoDB();
    const tempHolderData = await getTokenHolders(tokenMint);
    console.log("New holder data gathered in temporary storage");

    await collection.deleteMany({});
    console.log("Previous data in MongoDB cleared successfully");

    await saveToMongoDB(tempHolderData);
    const holders = await fetchFromMongoDB();

    const summaryData = {
      tokenMint,
      totalSupply: holders.reduce((acc, holder) => acc + holder.balance, 0),
      totalHolders: holders.length,
      fetchDate: new Date().toISOString(),
      holders,
    };

    console.log(`\nTotal holders with SOL balance > 0: ${holders.length}`);
    console.log("Sample of holders with SOL balance > 0:");
    // Uncomment to log holders
    // holders.forEach((holder, index) => {
    //   console.log(`${index + 1}. Owner: ${holder.address}, Token Balance: ${holder.balance.toLocaleString()} tokens (${holder.percentage}%), SOL Balance: ${holder.solBalance.toFixed(4)} SOL`);
    // });

    const endTime = Date.now();
    console.log(`\nCompleted in ${(endTime - startTime) / 1000} seconds`);
    return summaryData;
  } catch (error) {
    console.error("Main execution failed:", error);
    throw error;
  }
}

// Standalone execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS;
  main(TOKEN_MINT_ADDRESS);

  cron.schedule("*/1 * * * *", () => {
    console.log("Running scheduled task...");
    main(TOKEN_MINT_ADDRESS);
  });

  process.on("SIGINT", async () => {
    if (mongoClient) await mongoClient.close();
    console.log("MongoDB connection closed on exit");
    process.exit(0);
  });
}

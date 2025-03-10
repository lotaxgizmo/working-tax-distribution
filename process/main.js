import { distributeMain } from "./distribute.js";
import { withdrawMain } from "./withdrawTax.js";
import testSellMain from "./JupiterSell.js";
import fetchTokenHolders from "./ultimate-token-holders-fetcher.js";
import dotenv from "dotenv";
import MongoManager from "./mongoManager.js";
import SolanaManager from "./solanaManager.js";
import path from "path";
import { fileURLToPath } from "url";
import chokidar from "chokidar";
import * as fs from "fs";
import { transferToTwoWallets } from "./transferLogic.js";
import cron from "node-cron";

// Color utility functions
const colors = {
  blue: (text) => `\x1b[34m${text}\x1b[0m`,
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
};

// Get the directory name of the current module
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// File to store accumulated SOL amount
const ACCUMULATOR_FILE = "accumulated_sol.json";

// State variables
let totalSoldAmount = 0;
let mongoManager = null;
let solanaManager = null;
let withdrawInterval = null;
let sellInterval = null;
let distributeTask = null;
let fetchHoldersInterval = null;
const lastRunTimes = { withdraw: 0, sell: 0, distribute: 0, fetchHolders: 0 };
const isRunning = {
  withdraw: false,
  sell: false,
  distribute: false,
  fetchHolders: false,
};
let lastDistributeSuccess = Date.now();

// Load environment variables
dotenv.config();

// Function to reload environment variables
function reloadEnv() {
  try {
    console.log(colors.blue("Reloading environment variables..."));
    dotenv.config({ override: true });
    console.log(colors.green("Environment variables reloaded successfully"));
    return true;
  } catch (error) {
    console.error(colors.red("Error reloading environment variables:"), error);
    return false;
  }
}

// Function to watch for file changes
function setupFileWatchers() {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    const envWatcher = chokidar.watch(envPath, {
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 1000,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    });

    envWatcher.on("change", () => {
      console.log(colors.blue(".env file changed, reloading configuration..."));
      if (reloadEnv()) {
        restartDistributeTask();
        restartFetchHoldersTask();
      }
    });

    const processDir = __dirname;
    const jsWatcher = chokidar.watch("*.js", {
      cwd: processDir,
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 1000,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    });

    jsWatcher.on("change", (filepath) => {
      console.log(
        colors.blue(`Detected change in ${filepath}, restarting via PM2...`)
      );
      process.exit(0);
    });

    envWatcher.on("error", (error) =>
      console.error(colors.red("Env watcher error:"), error)
    );
    jsWatcher.on("error", (error) =>
      console.error(colors.red("JS watcher error:"), error)
    );
    console.log(colors.blue("PM2 File watchers set up successfully"));
  } catch (error) {
    console.error(colors.red("Error setting up file watchers:"), error);
    console.log(colors.yellow("Continuing without file watchers..."));
  }
}

// Load and save accumulated amount
function loadAccumulatedAmount() {
  try {
    if (fs.existsSync(ACCUMULATOR_FILE)) {
      const data = JSON.parse(fs.readFileSync(ACCUMULATOR_FILE, "utf8"));
      return data.amount || 0;
    }
  } catch (error) {
    console.error(colors.red("Error loading accumulated amount:"), error);
  }
  return 0;
}

function saveAccumulatedAmount(amount) {
  try {
    fs.writeFileSync(ACCUMULATOR_FILE, JSON.stringify({ amount }, null, 2));
  } catch (error) {
    console.error(colors.red("Error saving accumulated amount:"), error);
  }
}

totalSoldAmount = loadAccumulatedAmount();
console.log(colors.blue(`Loaded accumulated SOL amount: ${totalSoldAmount}`));

// Initialize connections
async function initializeConnections() {
  try {
    mongoManager = await MongoManager.getInstance();
    solanaManager = await SolanaManager.getInstance();
    console.log("All connections initialized successfully");
  } catch (error) {
    console.error("Error initializing connections:", error);
    throw error;
  }
}

// Retry utility
async function runWithRetry(operation, name, maxRetries = 3, delay = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(
        `${new Date().toISOString()} - Attempt ${attempt}/${maxRetries} failed for ${name}:`,
        error.message
      );
      if (attempt < maxRetries) {
        console.log(`Retrying ${name} in ${delay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.log(`All ${maxRetries} attempts failed for ${name}`);
        throw error;
      }
    }
  }
}

// Core operations
async function runWithdraw() {
  if (isRunning.withdraw) return;
  isRunning.withdraw = true;
  try {
    await runWithRetry(async () => await withdrawMain(), "withdraw");
    console.log(
      `${new Date().toISOString()} - ${colors.green(
        "Withdraw completed successfully."
      )}`
    );
  } catch (error) {
    console.error(
      `${new Date().toISOString()} - ${colors.red("Error during withdraw:")}`,
      error.message
    );
    console.log(
      `${new Date().toISOString()} - ${colors.yellow(
        "Continuing despite withdraw error..."
      )}`
    );
  } finally {
    lastRunTimes.withdraw = Date.now();
    isRunning.withdraw = false;
  }
}

async function runSell() {
  if (isRunning.sell) return;
  isRunning.sell = true;
  try {
    const amountSold = await runWithRetry(
      async () => await testSellMain(),
      "sell"
    );
    if (amountSold) {
      const amountForOtherWallet = amountSold * 0;
      const amountForDistribution = amountSold * 1;
      if (amountForOtherWallet > 0) {
        try {
          const transferSignature = await transferToTwoWallets(
            solanaManager.connection,
            solanaManager.wallet,
            amountForOtherWallet
          );
          console.log(
            `${new Date().toISOString()} - ${colors.green(
              `Transfer completed with signature: ${transferSignature}`
            )}`
          );
        } catch (transferError) {
          console.error(
            `${new Date().toISOString()} - ${colors.red(
              "Error transferring:"
            )}`,
            transferError
          );
        }
      } else {
        console.log(
          `${new Date().toISOString()} - ${colors.yellow(
            "No transfer needed (amountForOtherWallet is 0)"
          )}`
        );
      }
      totalSoldAmount += amountForDistribution;
      saveAccumulatedAmount(totalSoldAmount);
      console.log(
        `${new Date().toISOString()} - ${colors.green(
          `Successfully sold ${amountSold} SOL. Accumulated: ${totalSoldAmount} SOL`
        )}`
      );
    }
  } catch (error) {
    console.error(
      `${new Date().toISOString()} - ${colors.red("Error during sell:")}`,
      error.message
    );
  } finally {
    lastRunTimes.sell = Date.now();
    isRunning.sell = false;
  }
}

async function runDistribute() {
  if (isRunning.distribute) {
    console.log(
      `${new Date().toISOString()} - ${colors.yellow(
        "Distribute already running, skipping"
      )}`
    );
    return;
  }
  isRunning.distribute = true;
  try {
    console.log(`${new Date().toISOString()} - Starting distribution...`);
    const amountToDistribute = totalSoldAmount;
    console.log(
      `${new Date().toISOString()} - Amount to distribute: ${amountToDistribute} SOL`
    );
    if (amountToDistribute > 0) {
      totalSoldAmount = 0;
      saveAccumulatedAmount(0);
      await runWithRetry(async () => {
        console.log(`${new Date().toISOString()} - Calling distributeMain...`);
        await distributeMain(amountToDistribute);
        console.log(`${new Date().toISOString()} - distributeMain completed`);
      }, "distribute");
      lastDistributeSuccess = Date.now();
      console.log(
        `${new Date().toISOString()} - ${colors.green(
          `Distribution completed. Distributed: ${amountToDistribute} SOL`
        )}`
      );
    } else {
      console.log(
        `${new Date().toISOString()} - ${colors.yellow(
          "No amount to distribute"
        )}`
      );
      lastDistributeSuccess = Date.now();
    }
  } catch (error) {
    console.error(
      `${new Date().toISOString()} - ${colors.red(
        "Error during distribution:"
      )}`,
      error.message
    );
    totalSoldAmount = amountToDistribute;
    saveAccumulatedAmount(totalSoldAmount);
  } finally {
    lastRunTimes.distribute = Date.now();
    isRunning.distribute = false;
  }
}

async function runFetchHolders() {
  if (isRunning.fetchHolders) {
    console.log(
      `${new Date().toISOString()} - ${colors.yellow(
        "Fetch holders already running, skipping"
      )}`
    );
    return;
  }
  isRunning.fetchHolders = true;
  try {
    console.log(
      `${new Date().toISOString()} - Starting token holders fetch...`
    );
    const tokenMint = process.env.TOKEN_MINT_ADDRESS;
    await fetchTokenHolders(tokenMint);
    console.log(
      `${new Date().toISOString()} - ${colors.green(
        "Token holders fetch completed successfully"
      )}`
    );
  } catch (error) {
    console.error(
      `${new Date().toISOString()} - ${colors.red(
        "Error fetching token holders:"
      )}`,
      error.message
    );
  } finally {
    lastRunTimes.fetchHolders = Date.now();
    isRunning.fetchHolders = false;
  }
}

// Interval and task management
function startIntervals() {
  withdrawInterval = setInterval(
    runWithdraw,
    parseInt(process.env.WITHDRAW_INTERVAL) || 20000
  );
  sellInterval = setInterval(
    runSell,
    parseInt(process.env.SELL_INTERVAL) || 30000
  );
  distributeTask = cron.schedule("*/5 * * * *", runDistribute, {
    scheduled: true,
    timezone: "UTC",
  });
  fetchHoldersInterval = setInterval(runFetchHolders, 180000); // Every 3 minutes
  console.log(
    `${new Date().toISOString()} - All intervals and tasks started successfully`
  );
}

function restartDistributeTask() {
  if (distributeTask) {
    console.log(`${new Date().toISOString()} - Restarting distribute task...`);
    distributeTask.stop();
    distributeTask.start();
    console.log(`${new Date().toISOString()} - Distribute task restarted`);
  }
}

function restartFetchHoldersTask() {
  if (fetchHoldersInterval) {
    console.log(
      `${new Date().toISOString()} - Restarting fetch holders task...`
    );
    clearInterval(fetchHoldersInterval);
    fetchHoldersInterval = setInterval(runFetchHolders, 180000);
    console.log(`${new Date().toISOString()} - Fetch holders task restarted`);
  }
}

// Health check and watchdog
function runHealthCheck() {
  const now = Date.now();
  const distributeInterval =
    parseInt(process.env.DISTRIBUTE_INTERVAL) || 300000;
  const maxDelayDistribute = distributeInterval * 2;
  const maxDelayFetchHolders = 180000 * 2;
  if (
    !isRunning.distribute &&
    now - lastRunTimes.distribute > maxDelayDistribute &&
    now > distributeInterval
  ) {
    console.log(`${new Date().toISOString()} - Distribute task might be stuck`);
    restartDistributeTask();
  }
  if (
    !isRunning.fetchHolders &&
    now - lastRunTimes.fetchHolders > maxDelayFetchHolders &&
    now > 180000
  ) {
    console.log(
      `${new Date().toISOString()} - Fetch holders task might be stuck`
    );
    restartFetchHoldersTask();
  }
}

function watchdog() {
  const now = Date.now();
  const distributeInterval =
    parseInt(process.env.DISTRIBUTE_INTERVAL) || 300000;
  const maxUnresponsive = distributeInterval * 3;
  if (
    now - lastDistributeSuccess > maxUnresponsive &&
    now > distributeInterval
  ) {
    console.error(
      `${new Date().toISOString()} - Distribute unresponsive too long. Forcing restart...`
    );
    process.exit(1);
  }
}

function monitorResources() {
  const memoryUsage = process.memoryUsage();
  console.log(
    `${new Date().toISOString()} - Memory usage: RSS=${(
      memoryUsage.rss /
      1024 /
      1024
    ).toFixed(2)} MB, ` +
      `HeapTotal=${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB, ` +
      `HeapUsed=${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`
  );
}

// Main execution
async function runProcesses() {
  while (true) {
    try {
      setupFileWatchers();
      await initializeConnections();

      console.log("Running initial operations...");
      // Fetch holders first to ensure data is available
      await runFetchHolders();
      await runWithdraw();
      await runSell();

      console.log("Starting recurring operations...");
      startIntervals();

      setInterval(
        runHealthCheck,
        parseInt(process.env.HEALTH_CHECK_INTERVAL) || 60000
      );
      setInterval(watchdog, 60000);
      setInterval(monitorResources, 60000);
      setInterval(
        () =>
          console.log(
            `Process heartbeat - Still running at: ${new Date().toISOString()}`
          ),
        300000
      );

      await new Promise(() => {});
    } catch (error) {
      console.error("Critical error in main process:", error.message);
      console.log("Restarting in 5 seconds...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// Process handlers
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  restartDistributeTask();
  restartFetchHoldersTask();
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  restartDistributeTask();
  restartFetchHoldersTask();
});

process.on("SIGINT", async () => {
  console.log("Gracefully shutting down...");
  if (withdrawInterval) clearInterval(withdrawInterval);
  if (sellInterval) clearInterval(sellInterval);
  if (distributeTask) distributeTask.stop();
  if (fetchHoldersInterval) clearInterval(fetchHoldersInterval);
  if (mongoManager) await mongoManager.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Gracefully shutting down...");
  if (withdrawInterval) clearInterval(withdrawInterval);
  if (sellInterval) clearInterval(sellInterval);
  if (distributeTask) distributeTask.stop();
  if (fetchHoldersInterval) clearInterval(fetchHoldersInterval);
  if (mongoManager) await mongoManager.disconnect();
  process.exit(0);
});

runProcesses();

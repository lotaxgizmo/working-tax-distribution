import { distributeMain } from "./distribute.js";
import { withdrawMain } from "./withdrawTax.js";
import testSellMain from "./JupiterSell.js";
import dotenv from "dotenv";
import MongoManager from "./mongoManager.js";
import SolanaManager from "./solanaManager.js";
import path from "path";
import { fileURLToPath } from "url";
import chokidar from "chokidar";
import * as fs from "fs";
import { transferToTwoWallets } from "./transferLogic.js";

// Color utility functions.
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
    // Watch .env file
    const envPath = path.resolve(process.cwd(), ".env");
    const envWatcher = chokidar.watch(envPath, {
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 1000,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
    });

    envWatcher.on("change", () => {
      console.log(colors.blue(".env file changed, reloading configuration..."));
      if (reloadEnv()) {
        console.log(
          colors.blue("Restarting intervals with new configuration...")
        );
        restartIntervals();
      }
    });

    // Watch JS files in the process directory
    const processDir = __dirname;
    const jsWatcher = chokidar.watch("*.js", {
      cwd: processDir,
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 1000,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
    });

    jsWatcher.on("change", (filepath) => {
      console.log(
        colors.blue(
          `Detected change in ${filepath}, restarting entire process via PM2...`
        )
      );
      process.exit(0);
    });

    // Handle watcher errors
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

// Function to load accumulated amount from file
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

// Function to save accumulated amount to file
function saveAccumulatedAmount(amount) {
  try {
    fs.writeFileSync(ACCUMULATOR_FILE, JSON.stringify({ amount }, null, 2));
  } catch (error) {
    console.error(colors.red("Error saving accumulated amount:"), error);
  }
}

// Initialize totalSoldAmount from file
let totalSoldAmount = loadAccumulatedAmount();
console.log(colors.blue(`Loaded accumulated SOL amount: ${totalSoldAmount}`));

// Single accumulator to track total sold amount
let mongoManager = null;
let solanaManager = null;

// Interval references
let withdrawInterval = null;
let sellInterval = null;
let distributeInterval = null;

// Track last run times
let lastRunTimes = {
  withdraw: Date.now(),
  sell: Date.now(),
  distribute: Date.now(),
};

async function initializeConnections() {
  try {
    // Initialize both MongoDB and Solana connections
    mongoManager = await MongoManager.getInstance();
    solanaManager = await SolanaManager.getInstance();
    console.log("All connections initialized successfully");
  } catch (error) {
    console.error("Error initializing connections:", error);
    throw error; // Allow error to propagate for proper handling
  }
}

async function runWithRetry(operation, name, maxRetries = 3, delay = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(
        `Attempt ${attempt}/${maxRetries} failed for ${name}:`,
        error.message || error
      );
      if (attempt < maxRetries) {
        console.log(`Retrying ${name} in ${delay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  console.log(
    `All ${maxRetries} attempts failed for ${name}, will try again next interval`
  );
  return null;
}

async function runWithdraw() {
  try {
    await runWithRetry(async () => {
      await withdrawMain();
    }, "withdraw");
    lastRunTimes.withdraw = Date.now();
    console.log(colors.green("Withdraw completed successfully."));
  } catch (error) {
    lastRunTimes.withdraw = Date.now();
    console.error(colors.red("Error during withdraw:"), error.message || error);
    console.log(colors.yellow("Continuing despite withdraw error..."));
  }
}

async function runSell() {
  try {
    const amountSold = await runWithRetry(async () => {
      return await testSellMain();
    }, "sell");

    if (amountSold) {
      // Calculate 30% of the sold amount
      const amountForOtherWallet = amountSold * 0.3;
      // Calculate the remaining 70% for distribution
      const amountForDistribution = amountSold * 0.7;

      try {
        // Immediately send the 30% to be distributed between the two wallets
        const transferSignature = await transferToTwoWallets(
          solanaManager.connection,
          solanaManager.wallet,
          amountForOtherWallet
        );
        console.log(
          colors.green(
            `30% transfer completed with signature: ${transferSignature}`
          )
        );
      } catch (transferError) {
        console.error(colors.red("Error transferring 30%:"), transferError);
        // You might want to handle this error case appropriately
      }

      // Update the totalSoldAmount with only the 70% meant for distribution
      totalSoldAmount += amountForDistribution;
      saveAccumulatedAmount(totalSoldAmount); // Save after successful sell
      lastRunTimes.sell = Date.now();
      console.log(
        colors.green(
          `Successfully sold ${amountSold} SOL. ` +
            `30% (${amountForOtherWallet} SOL) sent to wallets, ` +
            `70% (${amountForDistribution} SOL) accumulated for distribution. ` +
            `Total accumulated: ${totalSoldAmount} SOL`
        )
      );
    }
  } catch (error) {
    lastRunTimes.sell = Date.now();

    if (error.transactionLogs) {
      console.log(
        colors.yellow("Transaction logs available, analyzing error...")
      );
      const logs = error.transactionLogs;

      if (logs.some((log) => log.includes("0x1771"))) {
        console.log(
          colors.yellow(
            "Jupiter swap error detected (0x1771) - likely price impact or slippage issue"
          )
        );
      } else if (logs.some((log) => log.includes("custom program error"))) {
        const errorLog = logs.find((log) =>
          log.includes("custom program error")
        );
        console.log(colors.yellow("Program error detected:"), errorLog);
      }

      console.log(colors.yellow("Transaction details:"));
      console.log(
        "Message:",
        error.transactionMessage || "No message available"
      );
      console.log("Signature:", error.signature || "No signature available");
    } else {
      console.error(
        colors.red("Error during sell operation:"),
        error.message || error
      );
    }
    console.log(colors.yellow("Will retry on next interval"));
  }
}

async function runDistribute() {
  try {
    const amountToDistribute = totalSoldAmount;
    if (amountToDistribute > 0) {
      totalSoldAmount = 0;
      saveAccumulatedAmount(0); // Reset file before distribution
      await runWithRetry(async () => {
        await distributeMain(amountToDistribute);
      }, "distribute");
      lastRunTimes.distribute = Date.now();
      console.log(
        `Distribution cycle completed. Distributed: ${amountToDistribute} tokens`
      );
    } else {
      lastRunTimes.distribute = Date.now();
      console.log("No amount to distribute at this time");
    }
  } catch (error) {
    lastRunTimes.distribute = Date.now();
    console.error("Error during distribution:", error.message || error);
    // Restore the amount if distribution failed
    totalSoldAmount = amountToDistribute;
    saveAccumulatedAmount(amountToDistribute); // Restore amount in file
    console.log("Distribution failed, amount restored for next attempt");
  }
}

async function safeStartIntervals() {
  while (true) {
    try {
      console.log("Starting intervals...");
      const withdrawIntervalTime =
        parseInt(process.env.WITHDRAW_INTERVAL) || 20000;
      const sellIntervalTime = parseInt(process.env.SELL_INTERVAL) || 30000;
      const distributeIntervalTime =
        parseInt(process.env.DISTRIBUTE_INTERVAL) || 60000;

      withdrawInterval = setInterval(runWithdraw, withdrawIntervalTime);
      sellInterval = setInterval(runSell, sellIntervalTime);
      distributeInterval = setInterval(runDistribute, distributeIntervalTime);

      console.log("All intervals started successfully");
      return;
    } catch (error) {
      console.error("Error starting intervals:", error.message || error);
      console.log("Retrying in 5 seconds...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

function restartIntervals() {
  console.log("Restarting all intervals...");
  try {
    // Clear existing intervals
    if (withdrawInterval) clearInterval(withdrawInterval);
    if (sellInterval) clearInterval(sellInterval);
    if (distributeInterval) clearInterval(distributeInterval);

    // Reset interval references
    withdrawInterval = null;
    sellInterval = null;
    distributeInterval = null;

    // Start new intervals
    safeStartIntervals();
  } catch (error) {
    console.error("Error in restartIntervals:", error.message || error);
    setTimeout(restartIntervals, 5000);
  }
}

// Enhanced health check function
function runHealthCheck() {
  try {
    const now = Date.now();
    const withdrawIntervalTime =
      parseInt(process.env.WITHDRAW_INTERVAL) || 20000;
    const sellIntervalTime = parseInt(process.env.SELL_INTERVAL) || 30000;
    const distributeIntervalTime =
      parseInt(process.env.DISTRIBUTE_INTERVAL) || 60000;

    const maxDelay = {
      withdraw: withdrawIntervalTime * 2,
      sell: sellIntervalTime * 2,
      distribute: distributeIntervalTime * 2,
    };

    let needsRestart = false;

    // Check each operation
    if (now - lastRunTimes.withdraw > maxDelay.withdraw) {
      console.log("Withdraw interval might be stuck");
      needsRestart = true;
    }
    if (now - lastRunTimes.sell > maxDelay.sell) {
      console.log("Sell interval might be stuck");
      needsRestart = true;
    }
    if (now - lastRunTimes.distribute > maxDelay.distribute) {
      console.log("Distribute interval might be stuck");
      needsRestart = true;
    }

    // Check if intervals are actually running
    if (!withdrawInterval || !sellInterval || !distributeInterval) {
      console.log("One or more intervals are not running");
      needsRestart = true;
    }

    if (needsRestart) {
      console.log("Detected stuck intervals, initiating restart...");
      restartIntervals();
    }
  } catch (error) {
    console.error("Error in health check:", error.message || error);
    // Even if health check fails, try to restart intervals
    setTimeout(restartIntervals, 5000);
  }
}

async function safeInitializeConnections() {
  while (true) {
    try {
      await initializeConnections();
      return;
    } catch (error) {
      console.error(
        "Error during initialization, retrying in 5 seconds:",
        error
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function runProcesses() {
  while (true) {
    try {
      // Set up file watchers first
      setupFileWatchers();

      // Initialize all connections first
      await safeInitializeConnections();

      // Run operations immediately
      console.log("Running initial operations...");
      await runWithdraw().catch((error) =>
        console.error("Initial withdraw error:", error)
      );
      await runSell().catch((error) =>
        console.error("Initial sell error:", error)
      );
      console.log("Initial operations completed");

      // Set up intervals for subsequent runs
      console.log("Setting up recurring operations...");
      await safeStartIntervals();

      // Set up health check
      const healthCheckInterval =
        parseInt(process.env.HEALTH_CHECK_INTERVAL) || 60000;
      setInterval(runHealthCheck, healthCheckInterval);

      // Heartbeat to show process is alive
      setInterval(() => {
        console.log(
          "Process heartbeat - Still running at:",
          new Date().toISOString()
        );
      }, 300000); // Every 5 minutes

      // Keep the process running forever
      await new Promise(() => {});
    } catch (error) {
      console.error("Critical error in main process:", error.message || error);
      console.log("Restarting entire process in 5 seconds...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// Error handling
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  console.log("Attempting recovery...");
  restartIntervals();
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  console.log("Attempting recovery...");
  restartIntervals();
});

// Handle process termination
process.on("SIGINT", async () => {
  console.log("Gracefully shutting down...");
  if (withdrawInterval) clearInterval(withdrawInterval);
  if (sellInterval) clearInterval(sellInterval);
  if (distributeInterval) clearInterval(distributeInterval);
  if (mongoManager) {
    await mongoManager.disconnect();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Gracefully shutting down...");
  if (withdrawInterval) clearInterval(withdrawInterval);
  if (sellInterval) clearInterval(sellInterval);
  if (distributeInterval) clearInterval(distributeInterval);
  if (mongoManager) {
    await mongoManager.disconnect();
  }
  process.exit(0);
});

// Start the process
runProcesses();

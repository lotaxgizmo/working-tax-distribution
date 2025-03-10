// Withdraw fees/tax from all fee holder accounts
import { Keypair, } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getTransferFeeAmount, unpackAccount, withdrawWithheldTokensFromAccounts, createAssociatedTokenAccountIdempotent, } from '@solana/spl-token';
import * as fs from 'fs';
import { DATA_FILE, generateExplorerTxUrl, connection, USE_SINGLE_AUTHORITY, getAuthority } from './config.js';
// Configuration for batch processing
const BATCH_SIZE = 20; // Maximum number of accounts to process in one transaction
const MAX_RETRIES = 3;  // Maximum number of retry attempts for failed transactions
const RETRY_DELAY = 2000;  // Delay between retries in milliseconds
// ANSI escape code for green text
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
// Helper function to import keypair data from JSON
function importKeypair(name) {
    if (!fs.existsSync(DATA_FILE)) {
        throw new Error(`File ${DATA_FILE} does not exist.`);
    }
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
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
// Helper function to sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Helper function to handle transaction with retries
async function executeWithRetry(operation, retryCount = 0) {
    try {
        return await operation();
    } catch (error) {
        if (retryCount < MAX_RETRIES) {
            console.log(yellow(`Attempt ${retryCount + 1} failed. Retrying in ${RETRY_DELAY / 1000} seconds...`));
            await sleep(RETRY_DELAY);
            return executeWithRetry(operation, retryCount + 1);
        } else {
            console.log(red(`Operation failed after ${MAX_RETRIES} attempts. Continuing with next operation.`));
            console.error(red(`Error details: ${error.message}`));
            if (error.logs) {
                console.error(red('Transaction logs:'));
                error.logs.forEach(log => console.error(red(`  ${log}`)));
            }
            return null;
        }
    }
}
export async function withdrawMain() {
    try {
        // Import existing keypairs
        const payer = USE_SINGLE_AUTHORITY ? getAuthority() : importKeypair('payer');
        const mintKeypair = importKeypair('mint');
        const feeVault = importKeypair('feeVault');
        const withdrawWithheldAuthority = USE_SINGLE_AUTHORITY ? getAuthority() : importKeypair('withdrawWithheldAuthority');
        // Create fee vault account if it doesn't exist
        const feeVaultAccount = await createAssociatedTokenAccountIdempotent(connection, payer, mintKeypair.publicKey, feeVault.publicKey, {}, TOKEN_2022_PROGRAM_ID);
        // Fetch Fee Accounts
        console.log(green("Fetching accounts with withheld fees..."));
        const allAccounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
            commitment: 'confirmed',
            filters: [
                {
                    memcmp: {
                        offset: 0,
                        bytes: mintKeypair.publicKey.toString(),
                    },
                },
            ],
        });
        const accountsToWithdrawFrom = [];
        for (const accountInfo of allAccounts) {
            const account = unpackAccount(accountInfo.pubkey, accountInfo.account, TOKEN_2022_PROGRAM_ID);
            const transferFeeAmount = getTransferFeeAmount(account);
            if (transferFeeAmount !== null && transferFeeAmount.withheldAmount > BigInt(0)) {
                accountsToWithdrawFrom.push(accountInfo.pubkey);
            }
        }
        if (accountsToWithdrawFrom.length === 0) {
            console.log(green("No accounts found with withheld fees."));
            return;
        }
        console.log(green(`Found ${accountsToWithdrawFrom.length} accounts with withheld fees`));
        // Split accounts into batches
        const batches = chunkArray(accountsToWithdrawFrom, BATCH_SIZE);
        console.log(green(`Processing in ${batches.length} batch(es) of up to ${BATCH_SIZE} accounts each`));
        // Process each batch
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            console.log(green(`Processing batch ${i + 1} of ${batches.length} (${batch.length} accounts)...`));

            const result = await executeWithRetry(async () => {
                const withdrawSig = await withdrawWithheldTokensFromAccounts(
                    connection,
                    payer,
                    mintKeypair.publicKey,
                    feeVaultAccount,
                    withdrawWithheldAuthority,
                    [],
                    batch
                );
                return withdrawSig;
            });

            if (result) {
                console.log(green(`Batch ${i + 1} complete:`), green(generateExplorerTxUrl(result)));
            }
        }
        console.log(green("Fee collection complete!"));
    } catch (error) {
        console.error(red("Unexpected error in withdrawMain:"), error);
        // Don't throw the error - we want the program to continue
        console.log(yellow("Continuing with program execution despite error..."));
    }
}


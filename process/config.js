import { Connection, Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();
// Network Configuration
export const HELIUS_CONFIG = {
    rpcUrl: process.env.HELIUS_RPC_URL
};
export const RPC_ENDPOINT = HELIUS_CONFIG.rpcUrl;
export const NETWORK = process.env.SOLANA_NETWORK;
// export const RPC_ENDPOINT = 'https://api.devnet.solana.com';
// export const NETWORK = 'devnet';
// Connection instance
console.log('RPC Endpoint:', RPC_ENDPOINT);
export const connection = new Connection(RPC_ENDPOINT, 'confirmed');
// File Configuration
export const DATA_FILE = process.env.DATA_FILE;
export const WALLET_FILE = process.env.WALLET_FILE;
export const TAX_COLLECTOR_WALLET_FILE = process.env.TAX_COLLECTOR_WALLET_FILE; // Add the wallet that will collect taxes
// Token Configuration
export const TOKEN_DECIMALS = 9;
export const TRANSFER_FEE_BASIS_POINTS = 500; // 5%
export const MAX_FEE = BigInt(2 ** 53 - 1); // Unlimited (max safe integer)
export const INITIAL_SUPPLY = 1000000; // Initial token supply (1 million tokens)
// Authority Configuration
export let USE_SINGLE_AUTHORITY = true; // Toggle this to true/false
export let USE_TAX_COLLECTOR_AS_AUTHORITY = true; // If true, tax collector will also have withdrawal authority
export let REVOKE_MINT_AUTHORITY = false; // If true, mint authority will be revoked after token creation
// MongoDB Configuration
export const MONGO_CONFIG = {
    uri: process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB_NAME,
    collectionName: process.env.MONGODB_COLLECTION
};
// Helper function to get authority
export function getAuthority() {
    if (!fs.existsSync(WALLET_FILE)) {
        throw new Error(`Wallet file ${WALLET_FILE} not found`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_FILE, 'utf-8'))));
}
// Helper function to get tax collector keypair
export function getTaxCollector() {
    if (!fs.existsSync(TAX_COLLECTOR_WALLET_FILE)) {
        throw new Error(`Tax collector wallet file ${TAX_COLLECTOR_WALLET_FILE} not found`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(TAX_COLLECTOR_WALLET_FILE, 'utf-8'))));
}
// Get the withdrawal authority (either tax collector or main authority)
export function getWithdrawalAuthority() {
    return USE_TAX_COLLECTOR_AS_AUTHORITY ? getTaxCollector() : getAuthority();
}
// Helper Functions
export function generateExplorerTxUrl(txId) {
    return `https://solscan.io/tx/${txId}?cluster=${NETWORK}`;
}
// Calculate amount with decimals
export function getTokenAmount(amount) {
    return BigInt(amount * Math.pow(10, TOKEN_DECIMALS));
}
// Calculate fee for a transfer amount
export function calculateFee(transferAmount) {
    const calcFee = (transferAmount * BigInt(TRANSFER_FEE_BASIS_POINTS)) / BigInt(10000);
    return calcFee > MAX_FEE ? MAX_FEE : calcFee;
}
// Get initial supply in base units (including decimals)
export function getInitialSupply() {
    return getTokenAmount(INITIAL_SUPPLY);
}

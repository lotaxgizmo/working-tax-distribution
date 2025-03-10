import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import dotenv from 'dotenv';

dotenv.config();

class SolanaManager {
    static instance = null;
    connection = null;
    wallet = null;
    provider = null;
    program = null;

    static async getInstance() {
        if (!SolanaManager.instance) {
            SolanaManager.instance = new SolanaManager();
            await SolanaManager.instance.initialize();
        }
        return SolanaManager.instance;
    }

    async initialize() {
        if (!this.connection) {
            if (!process.env.WALLET_FILE) {
                throw new Error('WALLET_FILE environment variable is not set');
            }

            // Get wallet path from env
            const walletPath = process.env.WALLET_FILE;

            // Load wallet from current env
            const keypair = Keypair.fromSecretKey(
                new Uint8Array(JSON.parse(readFileSync(walletPath, "utf-8")))
            );

            // Set up connection with current env
            this.connection = new Connection(
                process.env.HELIUS_RPC_URL,
                "confirmed"
            );

            // Initialize wallet and provider
            this.wallet = new anchor.Wallet(keypair);
            this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
                commitment: "confirmed",
            });
            anchor.setProvider(this.provider);

            console.log('Solana connection and wallet initialized');
        }
    }

    // Add reinitialize method to force refresh connections with new env values
    async reinitialize() {
        this.connection = null;
        this.wallet = null;
        this.provider = null;
        await this.initialize();
    }

    getConnection() {
        if (!this.connection) {
            throw new Error('Solana connection not established');
        }
        return this.connection;
    }

    getWallet() {
        if (!this.wallet) {
            throw new Error('Wallet not initialized');
        }
        return this.wallet;
    }

    getProvider() {
        if (!this.provider) {
            throw new Error('Provider not initialized');
        }
        return this.provider;
    }
}

export default SolanaManager; 
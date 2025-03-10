import { Keypair } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from 'fs';
import redisClient from '../redis/config.js';

const SUB_COLLECTORS_FILE = 'sub_collectors.json';
const REDIS_SUB_COLLECTORS_KEY = 'sub_collectors:list';

export class WalletManager {
    constructor(numberOfCollectors = 4) {
        this.numberOfCollectors = numberOfCollectors;
    }

    // Load or generate sub-collector wallets
    async initialize() {
        let subCollectors;

        // Try loading from Redis first (faster)
        const redisData = await redisClient.get(REDIS_SUB_COLLECTORS_KEY);
        if (redisData) {
            subCollectors = JSON.parse(redisData);
            console.log('Loaded sub-collectors from Redis');
            return subCollectors;
        }

        // Try loading from file
        if (existsSync(SUB_COLLECTORS_FILE)) {
            try {
                subCollectors = JSON.parse(readFileSync(SUB_COLLECTORS_FILE, 'utf-8'));
                console.log('Loaded sub-collectors from file');
            } catch (error) {
                console.error('Error reading sub-collectors file:', error);
            }
        }

        // Generate new wallets if needed
        if (!subCollectors || Object.keys(subCollectors).length !== this.numberOfCollectors) {
            subCollectors = this.generateSubCollectors();
            
            // Save to file with custom formatting
            const jsonString = JSON.stringify(subCollectors, (key, value) => {
                if (key === 'secretKey' && Array.isArray(value)) {
                    // Format secretKey array without spaces
                    return '[' + value.join(',') + ']';
                }
                return value;
            }, 2);
            
            // Replace the default array formatting with our compact version
            const formattedJson = jsonString.replace(/"secretKey": "\[(.*?)\]"/g, '"secretKey": [$1]');
            writeFileSync(SUB_COLLECTORS_FILE, formattedJson);
            console.log('Generated and saved new sub-collectors');
        }

        // Cache in Redis
        await redisClient.set(REDIS_SUB_COLLECTORS_KEY, JSON.stringify(subCollectors));
        
        return subCollectors;
    }

    // Generate new sub-collector wallets
    generateSubCollectors() {
        const subCollectors = {};
        
        for (let i = 1; i <= this.numberOfCollectors; i++) {
            const keypair = Keypair.generate();
            subCollectors[`collector${i}`] = {
                publicKey: keypair.publicKey.toString(),
                secretKey: Array.from(keypair.secretKey),
                index: i,
                created: Date.now()
            };
        }

        return subCollectors;
    }

    // Get all sub-collector public keys
    async getSubCollectorPublicKeys() {
        const subCollectors = await this.initialize();
        return Object.values(subCollectors).map(c => c.publicKey);
    }

    // Get a specific sub-collector's keypair
    async getSubCollectorKeypair(index) {
        const subCollectors = await this.initialize();
        const collector = subCollectors[`collector${index}`];
        
        if (!collector) {
            throw new Error(`Sub-collector ${index} not found`);
        }

        return Keypair.fromSecretKey(Uint8Array.from(collector.secretKey));
    }

    // Assign recipients to sub-collectors
    async assignRecipients(recipients) {
        const assignments = {};
        const recipientsPerCollector = Math.ceil(recipients.length / this.numberOfCollectors);

        for (let i = 0; i < this.numberOfCollectors; i++) {
            const start = i * recipientsPerCollector;
            const end = Math.min(start + recipientsPerCollector, recipients.length);
            assignments[`collector${i + 1}`] = recipients.slice(start, end);
        }

        // Store assignments in Redis
        await redisClient.set('sub_collectors:assignments', JSON.stringify(assignments));

        return assignments;
    }

    // Get recipients assigned to a specific sub-collector
    async getSubCollectorRecipients(index) {
        const assignments = JSON.parse(
            await redisClient.get('sub_collectors:assignments') || '{}'
        );
        return assignments[`collector${index}`] || [];
    }
}

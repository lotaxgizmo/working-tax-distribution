import { WalletManager } from './wallets.js';
import redisClient from '../redis/config.js';

// Import the Redis key constant
const REDIS_SUB_COLLECTORS_KEY = 'sub_collectors:list';

async function testWalletManager() {
    try {
        // Connect to Redis
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }

        // Clear previous data from Redis
        await redisClient.del(REDIS_SUB_COLLECTORS_KEY);
        await redisClient.del('sub_collectors:assignments');
        console.log('Cleared previous Redis data');

        // Initialize wallet manager
        const walletManager = new WalletManager(4); // 4 sub-collectors
        
        // Generate or load sub-collectors
        console.log('Initializing sub-collectors...');
        const subCollectors = await walletManager.initialize();
        
        // Display sub-collector info (public keys only for security)
        console.log('\nSub-collector public keys:');
        for (const [name, collector] of Object.entries(subCollectors)) {
            console.log(`${name}: ${collector.publicKey}`);
        }

        // Test recipient assignment
        const testRecipients = [
            'recipient1', 'recipient2', 'recipient3', 'recipient4',
            'recipient5', 'recipient6', 'recipient7', 'recipient8',
            'recipient9', 'recipient10', 'recipient11', 'recipient12'
        ];

        console.log('\nAssigning test recipients...');
        const assignments = await walletManager.assignRecipients(testRecipients);
        
        // Display assignments
        console.log('\nRecipient assignments:');
        for (const [collector, recipients] of Object.entries(assignments)) {
            console.log(`${collector}: ${recipients.length} recipients`);
            console.log('Recipients:', recipients);
        }

        // Test getting specific collector's recipients
        console.log('\nTesting recipient retrieval for collector 1:');
        const collector1Recipients = await walletManager.getSubCollectorRecipients(1);
        console.log('Collector 1 recipients:', collector1Recipients);

        // Cleanup
        await redisClient.quit();
        console.log('\nTest completed successfully!');
    } catch (error) {
        console.error('Test failed:', error);
        if (redisClient.isOpen) {
            await redisClient.quit();
        }
        process.exit(1);
    }
}

testWalletManager();

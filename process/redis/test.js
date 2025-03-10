import redisClient, { initializeCollector } from './config.js';

async function testRedisConnection() {
    try {
        // Connect to Redis
        await redisClient.connect();
        
        // Test basic set/get
        await redisClient.set('test:key', 'Hello Redis');
        const value = await redisClient.get('test:key');
        console.log('Test key value:', value);
        
        // Test collector initialization
        await initializeCollector(1);
        console.log('Initialized collector 1');
        
        // Test collector status retrieval
        const status = await redisClient.hGetAll('collector:1:status');
        console.log('Collector 1 status:', status);
        
        // Test some wallet jobs
        const testWallets = [
            'wallet1address',
            'wallet2address',
            'wallet3address'
        ];
        
        // Add test wallets to queue
        await redisClient.lPush('collector:1:jobs', testWallets);
        console.log('Added test wallets to queue');
        
        // Get queue length
        const queueLength = await redisClient.lLen('collector:1:jobs');
        console.log('Queue length:', queueLength);
        
        // Get a job from queue
        const nextJob = await redisClient.rPop('collector:1:jobs');
        console.log('Next job from queue:', nextJob);
        
        // Cleanup
        await redisClient.del('test:key');
        await redisClient.del('collector:1:status');
        await redisClient.del('collector:1:jobs');
        await redisClient.quit();
        
        console.log('Redis test completed successfully!');
    } catch (error) {
        console.error('Redis test failed:', error);
        if (redisClient.isOpen) {
            await redisClient.quit();
        }
        process.exit(1);
    }
}

testRedisConnection();

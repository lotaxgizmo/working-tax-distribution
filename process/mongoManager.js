import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

class MongoManager {
    static instance = null;
    client = null;
    db = null;

    static async getInstance() {
        if (!MongoManager.instance) {
            MongoManager.instance = new MongoManager();
            await MongoManager.instance.connect();
        }
        return MongoManager.instance;
    }

    async connect() {
        if (!this.client) {
            const uri = process.env.MONGODB_URI;
            const dbName = process.env.MONGODB_DB_NAME;

            this.client = new MongoClient(uri);
            await this.client.connect();
            this.db = this.client.db(dbName);
            console.log('MongoDB connection established');
        }
        return this.client;
    }

    getCollection(collectionName) {
        if (!this.db) {
            throw new Error('MongoDB connection not established');
        }
        return this.db.collection(collectionName);
    }

    async disconnect() {
        if (this.client) {
            await this.client.close();
            this.client = null;
            this.db = null;
            console.log('MongoDB connection closed');
        }
    }
}

export default MongoManager; 
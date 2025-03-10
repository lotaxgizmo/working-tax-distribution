# Token Tax Distribution System PRD

## Overview

This system automates the process of collecting token taxes, selling them for SOL, and distributing the SOL to token holders proportionally. It runs as a continuous process with error handling and automatic recovery.

## Core Components

### 1. Combined Process Manager (combinedprocess.js)

- **Purpose**: Orchestrates the entire workflow by managing three main intervals:

  - Withdraw tax collection
  - Token selling
  - SOL distribution

- **Key Features**:

  - File watchers for .env and JS files to enable hot reloading
  - Health check system to detect and recover from stuck intervals
  - Accumulator to track total SOL from sales
  - Persistent storage of accumulated amounts in JSON file
  - Graceful shutdown handling
  - Process heartbeat logging

- **Error Handling**:
  - Retry mechanism for failed operations
  - Interval auto-recovery
  - Uncaught exception handlers
  - Process termination handlers

### 2. Token Holder Tracking (ultimate-token-holders-fetcher.js)

- **Purpose**: Maintains up-to-date list of token holders and their balances

- **Features**:
  - Supports both Token Program and Token-2022 Program
  - Batched SOL balance fetching
  - Filters out holders with zero SOL balance
  - MongoDB integration for holder data persistence

### 3. Distribution System (distribute.js)

- **Purpose**: Distributes accumulated SOL to token holders

- **Key Features**:
  - Batch processing of distributions (10 recipients per transaction)
  - Dynamic priority fee calculation
  - Transaction retry mechanism
  - Detailed transaction logging

### 4. Configuration Management (config.js)

- **Purpose**: Centralizes configuration and provides helper functions

- **Key Settings**:
  - Network configuration (RPC endpoints)
  - Token decimals and fee settings
  - Authority management
  - MongoDB configuration

## Error Prevention & Recovery

### Global Error Handling

1. Process Level:

   - Uncaught exception handlers
   - Unhandled rejection handlers
   - Graceful shutdown handlers

2. Operation Level:

   - Retry mechanisms with exponential backoff
   - Health checks for stuck processes
   - Interval auto-recovery
   - Transaction confirmation verification

3. Data Persistence:
   - Accumulated amount backup in JSON file
   - MongoDB for holder data
   - State recovery on restart

### Connection Management

- Singleton pattern for database and blockchain connections
- Auto-reconnection logic
- Connection state verification before operations

## Environment Configuration

Required environment variables:

- HELIUS_RPC_URL: Solana RPC endpoint
- MONGODB_URI: MongoDB connection string
- MONGODB_DB_NAME: Database name
- MONGODB_COLLECTION: Collection name
- TOKEN_MINT_ADDRESS: Token contract address
- WALLET_FILE: Path to wallet key file
- TAX_COLLECTOR_WALLET_FILE: Path to tax collector wallet
- Various interval settings (WITHDRAW_INTERVAL, SELL_INTERVAL, etc.)

## Operational Flow

1. System initialization:

   - Set up file watchers
   - Initialize connections
   - Load accumulated amount
   - Start health check system

2. Main loop:

   - Withdraw tax (every WITHDRAW_INTERVAL)
   - Sell tokens (every SELL_INTERVAL)
   - Track accumulated SOL
   - Update holder list
   - Distribute SOL (every DISTRIBUTE_INTERVAL)

3. Continuous monitoring:
   - Health checks every HEALTH_CHECK_INTERVAL
   - Process heartbeat every 5 minutes
   - Auto-recovery from failures

## Recovery Mechanisms

1. Operation retries:

   - Maximum 3 attempts per operation
   - 5 second delay between retries
   - Exponential backoff for RPC rate limits

2. Interval management:

   - Auto-restart on failure
   - Health check monitoring
   - Configuration hot-reload

3. Data integrity:
   - Transaction confirmation verification
   - Accumulated amount persistence
   - MongoDB data consistency checks

## Performance Considerations

- Batched processing for distributions (10 recipients per tx)
- Dynamic priority fees for transactions
- Rate limit handling with exponential backoff
- Efficient holder data updates
- Connection pooling for MongoDB

## Security Features

- Environment variable based configuration
- Secure wallet management
- Transaction verification
- Error logging without sensitive data

## Introduction

This document outlines the Token Tax Distribution System, which automates the process of collecting token taxes, selling them for SOL, and distributing the SOL to token holders proportionally. The system is designed to run continuously with robust error handling and automatic recovery mechanisms.

## Architecture Diagram

(Include a visual representation of the system architecture here)

## Setup and Installation

1. **Environment Setup**:
   - Ensure Node.js and npm are installed.
   - Install MongoDB and ensure it is running.
2. **Dependencies**:
   - Run `npm install` to install all necessary packages.
3. **Configuration**:
   - Set up environment variables as specified in the Environment Configuration section.

## API Documentation

(Provide details of any APIs used or provided by the system, including endpoints, request/response formats, and example calls)

## Data Models

- **MongoDB Collections**:
  - **Token Holders**: Stores information about token holders, their balances, and SOL balances.
  - **Transactions**: Logs details of each transaction processed by the system.

## Security Considerations

- Secure storage of wallet keys and sensitive data.
- Access controls for database and API endpoints.
- Data encryption where applicable.

## Testing and Validation

- **Unit Tests**: Ensure individual components function correctly.
- **Integration Tests**: Validate interactions between components.
- **Tools**: Use Mocha or Jest for testing.

## Deployment Guide

- Deploy the system using Docker or a cloud service like AWS or Heroku.
- Set up CI/CD pipelines for automated testing and deployment.

## Troubleshooting and FAQs

- **Common Issues**: List of common problems and their solutions.
- **FAQs**: Answers to frequently asked questions.

## Glossary

- **SOL**: Solana's native cryptocurrency.
- **Token Mint**: The process of creating new tokens on the blockchain.

## References and Further Reading

- [Solana Documentation](https://docs.solana.com/)
- [MongoDB Documentation](https://docs.mongodb.com/)

## Imports

The following imports are used across the system:

- `dotenv`: For loading environment variables.
- `mongodb`: For MongoDB database interactions.
- `@solana/web3.js`: For Solana blockchain interactions.
- `@coral-xyz/anchor`: For Solana program interactions.
- `fs`: For file system operations.
- `path`: For handling file paths.
- `chokidar`: For file watching and hot reloading.
- `cross-fetch`: For making HTTP requests.
- `bn.js`: For handling big numbers in JavaScript.

## Smart Contract Interaction

### distributeMain Smart Contract

- **Purpose**: The `distributeMain` function is a key component of the distribution system, responsible for executing the distribution of SOL to token holders based on their respective shares.

- **Functionality**:

  - The function retrieves the list of token holders and their distribution percentages from MongoDB.
  - It calculates the total amount of SOL to be distributed and converts it into lamports (the smallest unit of SOL).
  - The distribution is processed in batches, with each batch containing up to 10 recipients.
  - For each batch, a transaction is created and signed, then sent to the Solana blockchain for execution.
  - The function includes a retry mechanism to handle transaction failures due to network issues or rate limits.

- **Transaction Details**:

  - Each transaction includes a priority fee to ensure timely processing on the Solana network.
  - Successful transactions are logged, and any failed transactions are retried or logged for further analysis.

- **Security**:
  - The smart contract ensures that only valid recipients with non-zero balances receive distributions.
  - All transactions are confirmed on the blockchain to verify successful execution.

This interaction is crucial for the system's ability to distribute collected taxes efficiently and securely to token holders.

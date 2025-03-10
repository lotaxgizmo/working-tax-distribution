// transferLogic.js

// This file will contain the logic to transfer % of the sold SOL to another wallet.

// Import necessary modules
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Transaction,
  SystemProgram,
  Connection,
  Keypair,
} from "@solana/web3.js";
import dotenv from "dotenv";
import BN from "bn.js";
import { readFileSync } from "fs";

dotenv.config();

const IDL = {
  version: "0.1.0",
  name: "sol_distribution",
  instructions: [
    {
      name: "distributeByPercentage",
      accounts: [
        { name: "fundingAccount", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "totalAmount", type: "u64" },
        { name: "percentages", type: { vec: "u32" } },
      ],
    },
  ],
};

const PROGRAM_ID = new PublicKey(
  "75VwsLZCFLbPsdfMAHs12AUtjy4Q9P48ESVLiUbEPE29"
);

async function transferToTwoWallets(connection, fromWallet, solAmount) {
  const lamports = solAmount * 1_000_000_000; // Convert SOL to lamports
  const provider = new anchor.AnchorProvider(connection, fromWallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program(IDL, PROGRAM_ID, provider);

  const recipients = [
    new PublicKey("5tjuQUkF4cjGE9qU878BbrLXosyUFtcvbSeSmzcPEeWH"),
    new PublicKey("GNWXYBhog4cWTk7oCcXbNEyoGmYZgVGw5Y3HEoUvcfoQ"),
  ];

  const percentages = [6600, 3400]; // 66% and 34% split

  const instruction = await program.methods
    .distributeByPercentage(new BN(lamports), percentages)
    .accounts({
      fundingAccount: fromWallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(
      recipients.map((recipient) => ({
        pubkey: recipient,
        isWritable: true,
        isSigner: false,
      }))
    )
    .instruction();

  const transaction = new Transaction().add(instruction);

  // Use the provider to send the transaction
  const signature = await provider.sendAndConfirm(transaction, [
    fromWallet.payer,
  ]);
  console.log(`Transferring ${solAmount} SOL (${lamports} lamports)`);
  console.log(`Transfer successful with signature: ${signature}`);

  return signature; // Return the signature for tracking
}

// Remove the example usage code at the bottom since we're importing this as a module
export { transferToTwoWallets };

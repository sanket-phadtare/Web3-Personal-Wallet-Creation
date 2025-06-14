import Web3 from 'web3';
import dotenv from 'dotenv';
import express from 'express';
import pg from 'pg';
const { Pool } = pg;
import crypto from 'crypto';
import Razorpay from 'razorpay';
import open from 'open';
import axios from 'axios';
import bodyParser from 'body-parser';

dotenv.config();
const app = express();

const web3 = new Web3('https://rpc-amoy.polygon.technology/');


app.post("/webhook",express.raw({ type: "application/json" }),(req, res) => 
  {
    try {
      const secret = process.env.WEBHOOK_SECRET;
      const razorpaySignature = req.headers["x-razorpay-signature"];
      const rawBody = req.body;

      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");

      if (expectedSignature === razorpaySignature) {
        const body = JSON.parse(rawBody.toString());
        const event = body.event;

        if (event === "payment_link.paid" || event === "payment.captured" ) 
          {
            const getMaticPrice = async () => {
            try {
                  const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=matic-network&vs_currencies=inr');
                  const priceInINR = response.data['matic-network'].inr;
                  const notes = body.payload.payment.entity.notes;
                  const amount =  body.payload.payment.entity.amount
                  const amountInINR = amount / 100;
                  const tokens = amountInINR / priceInINR;
                  const adminPrivateKey = process.env.PRIVATE_KEY;
                  const adminWallet = process.env.WALLET_ADDRESS;
                  const toAddress = notes.wallet_address;

                  const amountToSend = web3.utils.toWei(tokens.toFixed(4), 'ether');

                  const tx = {
                    to: toAddress,
                    value: amountToSend,
                    gas: 21000,
                    gasPrice: await web3.eth.getGasPrice(),
                    nonce: await web3.eth.getTransactionCount(adminWallet, 'pending'),
                  };

                  const signedTx = await web3.eth.accounts.signTransaction(tx, adminPrivateKey);
                  const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
                  console.log("Payment Captured Successfully for Wallet Address = ", notes.wallet_address);
                  console.log("Tokens Received: ", tokens.toFixed(4));
                  
                 
        }
         catch (error) 
         {
          console.error('Error fetching MATIC price:', error.message);
          }
        };

          getMaticPrice();
          

        } 

        else if(event === "payment.failed") 
          {
          console.log(`Received non-successful event: ${event}`);
        }
        else
        {
          console.log("")
        }

        return res.status(200).send("OK");
      } else {
        console.error("Invalid webhook signature");
        return res.status(400).send("Invalid signature");
      }
    } catch (error) {
      console.error("Webhook handler error:", error);
      return res.status(500).send("Server error");
    }
  }
);


app.use(express.json());

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});


function encryptPrivateKey(privateKey, password) {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(password, 'salt', 32); 
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return `${iv.toString('hex')}:${encrypted}`;
}

function decryptPrivateKey(encryptedKey, password) {
    const algorithm = 'aes-256-cbc';
    const [ivHex, encryptedData] = encryptedKey.split(':'); 
    const key = crypto.scryptSync(password, 'salt', 32);
    const iv = Buffer.from(ivHex, 'hex'); 

    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

app.post("/api/registeruser", async function(req,res) {
    const { name, email, password } = req.body;
    try {
        const account = web3.eth.accounts.create();
        const walletAddress = account.address;
        const privateKey = account.privateKey;

        const encryptedPrivateKey = encryptPrivateKey(privateKey, password);

        const query = `INSERT INTO users (name, email, password ,wallet_address, private_key) VALUES ($1, $2, $3, $4, $5) RETURNING *;`;
        const values = [name, email, password, walletAddress, encryptedPrivateKey];

        const result = await pool.query(query, values);

        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            walletAddress,
        });
    } catch (error) {
        console.error(`Registration failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/getprivatekey", async function(req, res) {
    const { email, password } = req.body;
    try {
        const query = `SELECT private_key FROM users WHERE email = $1;`;
        const values = [email];
        const result = await pool.query(query, values);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const encryptedPrivateKey = result.rows[0].private_key;
        const privateKey = decryptPrivateKey(encryptedPrivateKey, password);

        res.json({ success: true, privateKey });
    } catch (error) {
        console.error(`Error retrieving private key: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/getbalance", async function(req, res) {
    const { walletAddress } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ success: false, error: "walletAddress is required" });
    }

    try {
        const balance = await web3.eth.getBalance(walletAddress);
        res.json({ success: true, balance: web3.utils.fromWei(balance, 'ether') });
    } catch (error) {
        console.error(`Error fetching balance: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});


const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.post("/api/razorpay-payment", async function(req, res) {   
  const { amount, name, email } = req.body;

  if (!amount) {
    return res.status(400).json({ error: "Amount is required" });
  }

  try {
    const query = 'SELECT wallet_address FROM users WHERE email = $1';
    const value= [email];
    const result  = await pool.query(query,value);
    const wallet_address = result.rows[0].wallet_address;


    const response = await razorpay.paymentLink.create({
      amount: amount * 100, 
      currency: "INR",
      customer: {name, email,},
      notes: {wallet_address: wallet_address,},
      notify: {email: false,sms: true}
     
    });

    open(response.short_url);

    res.status(200).json({
      id: response.id,
      short_url: response.short_url,
      status: response.status,
      walletAddress: wallet_address
    });
  } catch (err) {
    console.error("Error creating payment link:", err);
    res.status(500).json({ error: "Unable to create payment link" });
  }
});


app.listen(1000, () => {
    console.log('Server is running on port 1000');
});

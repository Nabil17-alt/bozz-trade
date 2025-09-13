require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const axios = require('axios');
const { Server } = require('socket.io');
const { generateSignals, computeATR } = require('./lib/signal');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

let candles = [];
let openTrade = null;
let tradeId = 0;
let tradeHistory = [];

// ---------------- Telegram -----------------
function sendTelegramMessage(text) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return console.error("Telegram token/chat_id missing");

    axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: "HTML"
    })
        .then(res => console.log("Telegram sent"))
        .catch(err => console.error("Telegram error:", err.response?.data || err.message));
}

// ---------------- Demo candle -----------------
function generateDemoCandle(prev) {
    const open = prev ? prev.close : 100;
    const change = (Math.random() - 0.5) * 2;
    const close = open + change;
    const high = Math.max(open, close) + Math.random();
    const low = Math.min(open, close) - Math.random();
    return { time: new Date().toISOString(), open, high, low, close, volume: 1000 };
}

// ---------------- Realtime trading demo -----------------
function startDemo() {
    // Kirim update P/L tiap 10 detik
    setInterval(() => {
        if (openTrade) {
            sendTelegramMessage(
                `⏳ <b>Open Trade Update</b>\nSide: ${openTrade.side === 'buy' ? '🟢 Buy' : '🔴 Sell'}\nOpen: ${openTrade.openPrice.toFixed(2)}\nCurrent Price: ${(openTrade.side === 'buy' ? openTrade.openPrice + openTrade.unrealized : openTrade.openPrice - openTrade.unrealized).toFixed(2)}\nUnrealized P/L: ${openTrade.unrealized.toFixed(2)}`
            );
        }
    }, 10000);

    setInterval(() => {
        const candle = generateDemoCandle(candles[candles.length - 1]);
        candles.push(candle);
        if (candles.length > 200) candles.shift();

        const signals = generateSignals(candles);
        const atrArr = computeATR(
            candles.map(c => c.high),
            candles.map(c => c.low),
            candles.map(c => c.close),
            10,
            true
        );

        const latestSignal = signals[signals.length - 1];
        const latestATR = atrArr[atrArr.length - 1] || 0;

        if (latestSignal.sniperBuy || latestSignal.sniperSell) {
            const signalType = latestSignal.sniperBuy ? "Buy" : "Sell";
            const targetPrice = latestSignal.price + (signalType === "Buy" ? latestATR : -latestATR);

            io.emit('newSignal', { time: latestSignal.time, side: signalType, price: latestSignal.price, target: targetPrice });

            sendTelegramMessage(
                `📊 <b>New Signal</b>\nTime: ${latestSignal.time}\nSide: ${signalType === 'Buy' ? '🟢 Buy' : '🔴 Sell'}\nPrice: ${latestSignal.price.toFixed(2)}\nTarget: ${targetPrice.toFixed(2)}`
            );

            if (!openTrade) {
                tradeId++;
                openTrade = { id: tradeId, time: latestSignal.time, side: signalType.toLowerCase(), openPrice: latestSignal.price, targetPrice, result: null, unrealized: 0 };
                io.emit('tradeOpened', openTrade);

                sendTelegramMessage(
                    `⏳ <b>Trade Opened</b>\nSide: ${openTrade.side === 'buy' ? '🟢 Buy' : '🔴 Sell'}\nOpen: ${openTrade.openPrice.toFixed(2)}\nTarget: ${openTrade.targetPrice.toFixed(2)}`
                );
            }
        }

        if (openTrade) {
            const side = openTrade.side;
            const price = latestSignal.price;
            openTrade.unrealized = side === 'buy' ? price - openTrade.openPrice : openTrade.openPrice - price;
            io.emit('tradeUpdate', { ...openTrade });

            if ((side === 'buy' && price >= openTrade.targetPrice) || (side === 'sell' && price <= openTrade.targetPrice)) {
                openTrade.closePrice = price;
                openTrade.result = openTrade.unrealized;
                openTrade.unrealized = 0;
                tradeHistory.push(openTrade);
                io.emit('tradeClosed', openTrade);

                sendTelegramMessage(
                    `✅ <b>Trade Closed</b>\nSide: ${openTrade.side === 'buy' ? '🟢 Buy' : '🔴 Sell'}\nOpen: ${openTrade.openPrice.toFixed(2)}\nClose: ${openTrade.closePrice.toFixed(2)}\n${openTrade.result >= 0 ? '💰 Profit' : '❌ Loss'}: ${openTrade.result.toFixed(2)}`
                );

                openTrade = null;
            }
        }

    }, 1000);
}

// ---------------- Routes -----------------
app.get('/', (req, res) => res.json({ ok: true, msg: 'BOZZ TRADE Realtime Demo' }));
app.get('/start-demo', (req, res) => { startDemo(); res.json({ ok: true, msg: 'Demo started' }); });
app.get('/api/history', (req, res) => res.json(tradeHistory));
app.get('/history', (req, res) => res.sendFile(__dirname + '/public/history.html'));

// ---------------- Start server -----------------
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    sendTelegramMessage(`🚀 <b>Server Started</b>\nPort: ${PORT}\nTime: ${new Date().toISOString()}`);
});

// ---------------- Notify on exit/crash -----------------
function handleExit(err) {
    const msg = err
        ? `⚠️ <b>Server Crashed</b>\nError: ${err.message}\nTime: ${new Date().toISOString()}`
        : `⚠️ <b>Server Stopped</b>\nTime: ${new Date().toISOString()}`;
    sendTelegramMessage(msg);
    console.log(msg);
    process.exit(err ? 1 : 0);
}

process.on('exit', () => handleExit());
process.on('SIGINT', () => handleExit());
process.on('uncaughtException', err => handleExit(err));
process.on('unhandledRejection', err => handleExit(err));

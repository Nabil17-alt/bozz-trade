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

// ---------------- Multi-timeframe -----------------
const TIMEFRAMES = ['5m', '15m', '1h', '4h'];
const symbols = ['BTCUSDT', 'XAUUSDT'];
const candlesMap = {};

// trade history per symbol
const tradeHistory = { BTCUSDT: [], XAUUSDT: [] };
const openTrades = { BTCUSDT: null, XAUUSDT: null };

// ---------------- Binance API -----------------
async function fetchCandles(symbol, interval = '1h', limit = 200) {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const res = await axios.get(url);
        return res.data.map(c => ({
            time: new Date(c[0]).toISOString(),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5])
        }));
    } catch (err) {
        console.error('Fetch candle error:', err.message);
        return [];
    }
}

// ---------------- Process Signals -----------------
async function processMultiTF(symbol) {
    // Ambil semua candles
    candlesMap[symbol] = {};
    for (const tf of TIMEFRAMES) {
        candlesMap[symbol][tf] = await fetchCandles(symbol, tf);
    }

    // Hitung signals per timeframe
    const signals = {};
    for (const tf of TIMEFRAMES) {
        signals[tf] = generateSignals(candlesMap[symbol][tf]);
    }

    // Trend filter 1h & 4h
    const trend1h = signals['1h'].slice(-1)[0]?.trend;
    const trend4h = signals['4h'].slice(-1)[0]?.trend;

    // Entry 5m & 15m
    ['5m', '15m'].forEach(tf => {
        const latest = signals[tf].slice(-1)[0];
        if (!latest) return;

        const trendOk = (latest.sniperBuy && trend1h === 1 && trend4h === 1) ||
            (latest.sniperSell && trend1h === -1 && trend4h === -1);

        if (trendOk) {
            const atrArr = computeATR(
                candlesMap[symbol][tf].map(c => c.high),
                candlesMap[symbol][tf].map(c => c.low),
                candlesMap[symbol][tf].map(c => c.close),
                10,
                true
            );
            const latestATR = atrArr[atrArr.length - 1] || 0;
            const signalType = latest.sniperBuy ? 'Buy' : 'Sell';
            const targetPrice = latest.price + (signalType === 'Buy' ? latestATR : -latestATR);

            io.emit('newSignal', { symbol, tf, time: latest.time, side: signalType, price: latest.price, target: targetPrice });

            // Open trade otomatis (demo)
            if (!openTrades[symbol]) {
                const tradeId = Date.now();
                openTrades[symbol] = { id: tradeId, symbol, tf, time: latest.time, side: signalType.toLowerCase(), openPrice: latest.price, targetPrice, unrealized: 0 };
                io.emit('tradeOpened', openTrades[symbol]);
            }
        }
    });

    // Update open trades
    const openTrade = openTrades[symbol];
    if (openTrade) {
        const latestPrice = signals['5m'].slice(-1)[0]?.price || openTrade.openPrice;
        openTrade.unrealized = openTrade.side === 'buy' ? latestPrice - openTrade.openPrice : openTrade.openPrice - latestPrice;

        if ((openTrade.side === 'buy' && latestPrice >= openTrade.targetPrice) ||
            (openTrade.side === 'sell' && latestPrice <= openTrade.targetPrice)) {

            openTrade.closePrice = latestPrice;
            openTrade.result = openTrade.unrealized;
            openTrade.unrealized = 0;
            tradeHistory[symbol].push(openTrade);
            io.emit('tradeClosed', openTrade);
            openTrades[symbol] = null;
        } else {
            io.emit('tradeUpdate', openTrade);
        }
    }
}

// ---------------- Start Live Demo -----------------
function startLiveDemo() {
    setInterval(() => symbols.forEach(s => processMultiTF(s)), 60 * 1000); // update tiap 1 menit
}

// ---------------- Routes -----------------
app.get('/', (req, res) => res.json({ ok: true, msg: 'BOZZ TRADE Live Demo' }));
app.get('/start-live', (req, res) => { startLiveDemo(); res.json({ ok: true, msg: 'Live demo started' }); });
app.get('/api/history/:symbol', (req, res) => {
    const s = req.params.symbol.toUpperCase();
    res.json(tradeHistory[s] || []);
});
app.get('/history', (req, res) => res.sendFile(__dirname + '/public/history.html'));

// ---------------- Start server -----------------
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    sendTelegramMessage(`🚀 <b>Server Started</b>\nPort: ${PORT}\nTime: ${new Date().toISOString()}`);
});

// ---------------- Exit / Crash -----------------
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

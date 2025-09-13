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

// ---------------- CONFIG -----------------
const TIMEFRAMES = ['5m', '15m', '1h', '4h'];
const symbols = ['BTCUSDT', 'XAUUSDT'];
const candlesMap = {};
const tradeHistory = { BTCUSDT: [], XAUUSDT: [] };
const openTrades = { BTCUSDT: null, XAUUSDT: null };
const defaultLot = 0.01; // Default lot

// ---------------- Telegram -----------------
function sendTelegramMessage(text, type = '') {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return console.error("Telegram token/chat_id missing");
    axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: "HTML"
    })
        .then(() => console.log("Telegram sent:"))
        .catch(err => console.error("Telegram error:", err.response?.data || err.message));
}

function formatNumber(n) {
    return n === undefined || n === null ? '-' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dt) {
    if (!dt) return '-';
    const d = new Date(dt);
    if (isNaN(d)) return dt;
    return d.toLocaleString('en-GB', { hour12: false });
}

function formatSide(side) {
    if (!side) return '-';
    return side.toUpperCase() === 'BUY' ? '<b>BUY</b>' : '<b>SELL</b>';
}

function telegramMsg(type, data = {}) {
    switch (type) {
        case 'STARTUP':
            return `🚀 <b>Server Started</b>\n<b>Port:</b> ${data.port || '-'}\n<b>Time:</b> ${formatDate(data.time)}`;
        case 'OPEN':
            return `💰 <b>Open Trade</b>\n<b>Symbol:</b> ${data.symbol || '-'}\n<b>Side:</b> ${formatSide(data.side)}\n<b>Lot:</b> ${formatNumber(data.lotSize)}\n<b>Open:</b> ${formatNumber(data.openPrice)}\n<b>TP:</b> ${formatNumber(data.targetPrice)}\n<b>SL:</b> ${formatNumber(data.stopLoss)}\n<b>Time:</b> ${formatDate(data.time)}`;
        case 'CLOSED':
            return `✅ <b>Trade Closed</b>\n<b>Symbol:</b> ${data.symbol || '-'}\n<b>Side:</b> ${formatSide(data.side)}\n<b>Lot:</b> ${formatNumber(data.lotSize)}\n<b>Open:</b> ${formatNumber(data.openPrice)}\n<b>Close:</b> ${formatNumber(data.closePrice)}\n<b>P/L:</b> <b>${data.result >= 0 ? '+' : ''}${formatNumber(data.result)}</b>\n<b>Time:</b> ${formatDate(data.time)}`;
        case 'SIGNAL':
            return `📊 <b>New Signal</b>\n<b>Symbol:</b> ${data.symbol || '-'}\n<b>TF:</b> ${data.tf || '-'}\n<b>Side:</b> ${formatSide(data.side)}\n<b>Price:</b> ${formatNumber(data.openPrice || data.price)}\n<b>TP:</b> ${formatNumber(data.targetPrice)}\n<b>SL:</b> ${formatNumber(data.stopLoss)}\n<b>Lot:</b> ${formatNumber(data.lotSize)}\n<b>Time:</b> ${formatDate(data.time)}`;
        case 'UPDATE':
            return `🔄 <b>Trade Update</b>\n<b>Symbol:</b> ${data.symbol || '-'}\n<b>Side:</b> ${formatSide(data.side)}\n<b>Unrealized P/L:</b> ${data.unrealized >= 0 ? '+' : ''}${formatNumber(data.unrealized)}\n<b>Time:</b> ${formatDate(data.time)}`;
        case 'ERROR':
            return `❌ <b>Server Crashed</b>\n<b>Error:</b> <i>${data.error || '-'}</i>\n<b>Time:</b> ${formatDate(data.time)}`;
        case 'STOP':
            return `⚠️ <b>Server Stopped</b>\n<b>Time:</b> ${formatDate(data.time)}`;
        default:
            return '';
    }
}

// ---------------- INITIAL LOGS -----------------
function sendInitialTelegramLogs() {
    sendTelegramMessage(telegramMsg('STARTUP', { port: PORT, time: new Date() }));
    // Open trades
    Object.keys(openTrades).forEach(symbol => {
        const t = openTrades[symbol];
        if (t) {
            sendTelegramMessage(telegramMsg('OPEN', t));
        }
    });
    // Trade history
    Object.keys(tradeHistory).forEach(symbol => {
        tradeHistory[symbol].forEach(trade => {
            sendTelegramMessage(telegramMsg('CLOSED', trade));
        });
    });
    sendTelegramMessage(`🟢 <b>Live Demo Active</b>\n<b>Symbols:</b> ${symbols.join(', ')}\n<b>Timeframes:</b> ${TIMEFRAMES.join(', ')}`);
}

// ---------------- SOCKET.IO -----------------
io.on('connection', (socket) => {
    console.log('Client connected');

    socket.on('newSignal', sig => {
        sendTelegramMessage(telegramMsg('SIGNAL', sig));
    });

    socket.on('tradeUpdate', trade => {
        sendTelegramMessage(telegramMsg('UPDATE', trade));
    });
});

// ---------------- FETCH CANDLES -----------------
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

// ---------------- TRADE HANDLER -----------------
function handleTrade(symbol, latestSignal, atr) {
    const openTrade = openTrades[symbol];
    if (!latestSignal) return;

    const lotSize = defaultLot;
    // Side: 'Buy'/'Sell' (frontend expects capitalized)
    const side = latestSignal.sniperBuy ? 'Buy' : latestSignal.sniperSell ? 'Sell' : latestSignal.buySignal ? 'Buy' : 'Sell';
    const openPrice = latestSignal.price;
    const stopLoss = side === 'Buy' ? openPrice - atr : openPrice + atr;
    const targetPrice = side === 'Buy' ? openPrice + atr * 2 : openPrice - atr * 2;

    if (!openTrade) {
        const tradeId = Date.now();
        openTrades[symbol] = {
            id: tradeId,
            symbol,
            tf: latestSignal.tf,
            time: latestSignal.time,
            side,
            openPrice,
            targetPrice,
            stopLoss,
            unrealized: 0,
            lotSize
        };
        io.emit('tradeOpened', openTrades[symbol]);
        sendTelegramMessage(telegramMsg('OPEN', openTrades[symbol]));
        return;
    }

    // Update unrealized P/L
    const latestPrice = latestSignal.price;
    openTrade.unrealized = openTrade.side === 'Buy' ? latestPrice - openTrade.openPrice : openTrade.openPrice - latestPrice;

    // Close if TP or SL reached
    if ((openTrade.side === 'Buy' && (latestPrice >= openTrade.targetPrice || latestPrice <= openTrade.stopLoss)) ||
        (openTrade.side === 'Sell' && (latestPrice <= openTrade.targetPrice || latestPrice >= openTrade.stopLoss))) {
        openTrade.closePrice = latestPrice;
        openTrade.result = openTrade.unrealized;
        tradeHistory[symbol].push(openTrade);
        io.emit('tradeClosed', openTrade);
        sendTelegramMessage(telegramMsg('CLOSED', openTrade));
        openTrades[symbol] = null;
    }
}

// ---------------- MULTI-TF PROCESSOR -----------------
async function processMultiTF(symbol) {
    candlesMap[symbol] = {};
    for (const tf of TIMEFRAMES) {
        candlesMap[symbol][tf] = await fetchCandles(symbol, tf);
    }

    const signalsPerTF = {};
    for (const tf of TIMEFRAMES) {
        signalsPerTF[tf] = generateSignals(candlesMap[symbol][tf]);
    }

    const trend1h = signalsPerTF['1h'].slice(-1)[0]?.trend;
    const trend4h = signalsPerTF['4h'].slice(-1)[0]?.trend;

    ['5m', '15m'].forEach(tf => {
        const latest = signalsPerTF[tf].slice(-1)[0];
        if (!latest) return;

        const atrArr = computeATR(
            candlesMap[symbol][tf].map(c => c.high),
            candlesMap[symbol][tf].map(c => c.low),
            candlesMap[symbol][tf].map(c => c.close),
            10,
            true
        );
        const latestATR = atrArr[atrArr.length - 1] || 0;

        const trendOk = (latest.sniperBuy && trend1h === 1 && trend4h === 1) ||
            (latest.sniperSell && trend1h === -1 && trend4h === -1);

        if (trendOk) handleTrade(symbol, latest, latestATR);

        if (trendOk) {
            // Lengkapi field agar sesuai frontend
            const side = latest.sniperBuy ? 'Buy' : 'Sell';
            const openPrice = latest.price;
            const stopLoss = side === 'Buy' ? openPrice - latestATR : openPrice + latestATR;
            const targetPrice = side === 'Buy' ? openPrice + latestATR * 2 : openPrice - latestATR * 2;
            io.emit('newSignal', {
                symbol,
                tf,
                time: latest.time,
                side,
                openPrice,
                stopLoss,
                targetPrice,
                price: latest.price,
                lotSize: defaultLot,
                result: null,
                unrealized: null
            });
        }
    });

    const openTrade = openTrades[symbol];
    if (openTrade) {
        const latestPrice = signalsPerTF['5m'].slice(-1)[0]?.price || openTrade.openPrice;
        openTrade.unrealized = openTrade.side === 'buy' ? latestPrice - openTrade.openPrice : openTrade.openPrice - latestPrice;
        io.emit('tradeUpdate', openTrade);
    }
}

// ---------------- LIVE DEMO -----------------
function startLiveDemo() {
    symbols.forEach(s => processMultiTF(s));
    setInterval(() => symbols.forEach(s => processMultiTF(s)), 60 * 1000);
}

// ---------------- ROUTES -----------------
app.get('/', (req, res) => res.json({ ok: true, msg: 'BOZZ TRADE Live Demo' }));
app.get('/start-live', (req, res) => { startLiveDemo(); res.json({ ok: true, msg: 'Live demo started' }); });

app.get('/api/history/:symbol', (req, res) => { const s = req.params.symbol.toUpperCase(); res.json(tradeHistory[s] || []); });
app.get('/history', (req, res) => res.sendFile(__dirname + '/public/history.html'));

// ---------------- SERVER -----------------
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    sendInitialTelegramLogs();
});

// ---------------- EXIT HANDLER -----------------
function handleExit(err) {
    const now = new Date();
    if (err) {
        sendTelegramMessage(telegramMsg('ERROR', { error: err.message, time: now }));
        console.log(err);
    } else {
        sendTelegramMessage(telegramMsg('STOP', { time: now }));
    }
    process.exit(err ? 1 : 0);
}
process.on('exit', () => handleExit());
process.on('SIGINT', () => handleExit());
process.on('uncaughtException', err => handleExit(err));
process.on('unhandledRejection', err => handleExit(err));

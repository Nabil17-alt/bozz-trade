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

    const prefix = type ? `[${type}] ` : '';
    axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: prefix + text,
        parse_mode: "HTML"
    })
        .then(() => console.log("Telegram sent:", prefix + text))
        .catch(err => console.error("Telegram error:", err.response?.data || err.message));
}

// ---------------- INITIAL LOGS -----------------
function sendInitialTelegramLogs() {
    sendTelegramMessage(`Server Started\nPort:${PORT}\nTime:${new Date().toISOString()}`, 'STARTUP');

    // Open trades
    Object.keys(openTrades).forEach(symbol => {
        const t = openTrades[symbol];
        if (t) {
            sendTelegramMessage(
                `${symbol.toUpperCase()} ${t.side.toUpperCase()} @${t.openPrice.toFixed(2)} TP:${t.targetPrice.toFixed(2)} SL:${t.stopLoss.toFixed(2)} Lot:${t.lotSize}`,
                'STARTUP'
            );
        }
    });

    // Trade history
    Object.keys(tradeHistory).forEach(symbol => {
        tradeHistory[symbol].forEach(trade => {
            sendTelegramMessage(
                `${symbol.toUpperCase()} ${trade.side.toUpperCase()} Result:${trade.result?.toFixed(2)} Open:${trade.openPrice.toFixed(2)} Close:${trade.closePrice?.toFixed(2)} Lot:${trade.lotSize}`,
                'STARTUP'
            );
        });
    });

    sendTelegramMessage(`Live Demo Active\nSymbols: ${symbols.join(', ')}\nTimeframes: ${TIMEFRAMES.join(', ')}`, 'STARTUP');
}

// ---------------- SOCKET.IO -----------------
io.on('connection', (socket) => {
    console.log('Client connected');

    socket.on('newSignal', sig => {
        const msg = `New Signal: ${sig.symbol} ${sig.side}\nTF: ${sig.tf}\nPrice: ${sig.price.toFixed(2)}\nTarget: ${sig.target?.toFixed(2) || '-'}`;
        sendTelegramMessage(msg, 'LIVE');
    });

    socket.on('tradeUpdate', trade => {
        const msg = `Trade Update: ${trade.symbol} ${trade.side.toUpperCase()}\nUnrealized P/L: ${trade.unrealized.toFixed(2)}`;
        sendTelegramMessage(msg, 'LIVE');
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
        sendTelegramMessage(
            `Open Trade ${symbol.toUpperCase()} ${side} @${openPrice.toFixed(2)} TP:${targetPrice.toFixed(2)} SL:${stopLoss.toFixed(2)} Lot:${lotSize}`,
            'LIVE'
        );
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
        sendTelegramMessage(
            `Trade Closed ${symbol.toUpperCase()} Result:${openTrade.result.toFixed(2)} Open:${openTrade.openPrice.toFixed(2)} Close:${openTrade.closePrice.toFixed(2)} Lot:${openTrade.lotSize}`,
            'CLOSED'
        );
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
    const msg = err ? `Server Crashed\nError: ${err.message}\nTime: ${new Date().toISOString()}` : `Server Stopped\nTime: ${new Date().toISOString()}`;
    sendTelegramMessage(msg, 'ERROR');
    console.log(msg);
    process.exit(err ? 1 : 0);
}
process.on('exit', () => handleExit());
process.on('SIGINT', () => handleExit());
process.on('uncaughtException', err => handleExit(err));
process.on('unhandledRejection', err => handleExit(err));

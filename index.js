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
// Multi-entry: openTrades[symbol] = array of open trades
const openTrades = { BTCUSDT: [], XAUUSDT: [] };
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
    // WIB = UTC+7
    const wibTime = new Date(d.getTime() + 7 * 60 * 60 * 1000);
    // Format: dd/MM/yyyy, HH:mm:ss WIB
    const pad = n => n.toString().padStart(2, '0');
    const day = pad(wibTime.getUTCDate());
    const month = pad(wibTime.getUTCMonth() + 1);
    const year = wibTime.getUTCFullYear();
    const hour = pad(wibTime.getUTCHours());
    const min = pad(wibTime.getUTCMinutes());
    const sec = pad(wibTime.getUTCSeconds());
    return `${day}/${month}/${year}, ${hour}:${min}:${sec} WIB`;
}

function formatSide(side) {
    if (!side) return '-';
    return side.toUpperCase() === 'BUY' ? '<b>BUY</b>' : '<b>SELL</b>';
}

function telegramMsg(type, data = {}) {
    switch (type) {
        case 'STARTUP':
            return `🚀 <b>Server Started</b>\n<b>Dashboard:</b> <a href=\"https://bozz-trade-production.up.railway.app/history\">bozz-trade-production.up.railway.app/history</a>\n🕒 <b>Time:</b> ${formatDate(data.time)}`;
        case 'OPEN':
            return `💰 <b>New Trade Opened</b>\n━━━━━━━━━━━━━━\n<b>Symbol:</b> <code>${data.symbol || '-'}</code>\n<b>Side:</b> ${formatSide(data.side)}\n<b>Lot:</b> <code>${formatNumber(data.lotSize)}</code>\n<b>Open Price:</b> <code>${formatNumber(data.openPrice)}</code>\n<b>TP:</b> <code>${formatNumber(data.targetPrice)}</code>\n<b>SL:</b> <code>${formatNumber(data.stopLoss)}</code>\n🕒 <b>Time:</b> ${formatDate(data.time)}`;
        case 'CLOSED':
            return `✅ <b>Trade Closed</b>\n━━━━━━━━━━━━━━\n<b>Symbol:</b> <code>${data.symbol || '-'}</code>\n<b>Side:</b> ${formatSide(data.side)}\n<b>Lot:</b> <code>${formatNumber(data.lotSize)}</code>\n<b>Open:</b> <code>${formatNumber(data.openPrice)}</code>\n<b>Close:</b> <code>${formatNumber(data.closePrice)}</code>\n<b>P/L:</b> <b>${data.result >= 0 ? '🟢 +' : '🔴 '}${formatNumber(data.result)}</b>\n🕒 <b>Time:</b> ${formatDate(data.time)}`;
        case 'SIGNAL':
            return `📊 <b>New Signal</b>\n━━━━━━━━━━━━━━\n<b>Symbol:</b> <code>${data.symbol || '-'}</code>\n<b>TF:</b> <code>${data.tf || '-'}</code>\n<b>Side:</b> ${formatSide(data.side)}\n<b>Price:</b> <code>${formatNumber(data.openPrice || data.price)}</code>\n<b>TP:</b> <code>${formatNumber(data.targetPrice)}</code>\n<b>SL:</b> <code>${formatNumber(data.stopLoss)}</code>\n<b>Lot:</b> <code>${formatNumber(data.lotSize)}</code>\n🕒 <b>Time:</b> ${formatDate(data.time)}`;
        case 'UPDATE':
            return `🔄 <b>Trade Update</b>\n━━━━━━━━━━━━━━\n<b>Symbol:</b> <code>${data.symbol || '-'}</code>\n<b>Side:</b> ${formatSide(data.side)}\n<b>Unrealized P/L:</b> <b>${data.unrealized >= 0 ? '🟢 +' : '🔴 '}${formatNumber(data.unrealized)}</b>\n🕒 <b>Time:</b> ${formatDate(data.time)}`;
        case 'ERROR':
            return `❌ <b>Server Error</b>\n━━━━━━━━━━━━━━\n<b>Error:</b> <i>${data.error || '-'}</i>\n🕒 <b>Time:</b> ${formatDate(data.time)}`;
        case 'STOP':
            return `⚠️ <b>Server Stopped</b>\n🕒 <b>Time:</b> ${formatDate(data.time)}`;
        default:
            return '';
    }
}

// ---------------- INITIAL LOGS -----------------
function sendInitialTelegramLogs() {
    sendTelegramMessage(telegramMsg('STARTUP', { port: PORT, time: new Date() }));
    // Open trades
    Object.keys(openTrades).forEach(symbol => {
        const arr = openTrades[symbol];
        if (Array.isArray(arr)) {
            arr.forEach(t => sendTelegramMessage(telegramMsg('OPEN', t)));
        }
    });
    // Trade history
    Object.keys(tradeHistory).forEach(symbol => {
        tradeHistory[symbol].forEach(trade => {
            sendTelegramMessage(telegramMsg('CLOSED', trade));
        });
    });
    sendTelegramMessage(
        `🟢 <b>Live Demo Active</b>\n━━━━━━━━━━━━━━\n<b>Dashboard:</b> <a href=\"https://bozz-trade-production.up.railway.app/history\">bozz-trade-production.up.railway.app/history</a>\n<b>Symbols:</b> <code>${symbols.join(', ')}</code>\n<b>Timeframes:</b> <code>${TIMEFRAMES.join(', ')}</code>\n🕒 <b>Time:</b> ${formatDate(new Date())}`
    );
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
    if (!latestSignal) return;

    const lotSize = defaultLot;
    const side = latestSignal.sniperBuy ? 'Buy' : latestSignal.sniperSell ? 'Sell' : latestSignal.buySignal ? 'Buy' : 'Sell';
    const openPrice = latestSignal.price;
    const tpMult = (latestSignal.sniperBuy || latestSignal.sniperSell) ? 2 : 1;
    const stopLoss = side === 'Buy' ? openPrice - atr : openPrice + atr;
    const targetPrice = side === 'Buy' ? openPrice + atr * tpMult : openPrice - atr * tpMult;
    const tradeId = Date.now() + Math.floor(Math.random() * 10000); // unique id
    const trade = {
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
    openTrades[symbol].push(trade);
    io.emit('tradeOpened', trade);
    sendTelegramMessage(telegramMsg('OPEN', trade));
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

    // Untuk setiap timeframe, cek sinyal terbaru
    for (const tf of TIMEFRAMES) {
        const latest = signalsPerTF[tf].slice(-1)[0];
        if (!latest) continue;

        const atrArr = computeATR(
            candlesMap[symbol][tf].map(c => c.high),
            candlesMap[symbol][tf].map(c => c.low),
            candlesMap[symbol][tf].map(c => c.close),
            10,
            true
        );
        const latestATR = atrArr[atrArr.length - 1] || 0;

        // Jika ada sinyal buy/sell atau sniper, langsung open posisi
        if (latest.sniperBuy || latest.sniperSell || latest.buySignal || latest.sellSignal) {
            // Kirim sinyal ke frontend
            const side = latest.sniperBuy || latest.buySignal ? 'Buy' : 'Sell';
            // TP multiplier: sniper = 2, biasa = 1
            const tpMult = (latest.sniperBuy || latest.sniperSell) ? 2 : 1;
            const openPrice = latest.price;
            const stopLoss = side === 'Buy' ? openPrice - latestATR : openPrice + latestATR;
            const targetPrice = side === 'Buy' ? openPrice + latestATR * tpMult : openPrice - latestATR * tpMult;
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
            // Open posisi jika belum ada trade terbuka
            handleTrade(symbol, { ...latest, tf }, latestATR);
        }
    }

    // Update unrealized P/L dan close trade jika TP/SL tercapai untuk semua posisi aktif
    const openList = openTrades[symbol];
    if (openList && openList.length > 0) {
        // Copy array karena kita akan hapus trade jika closed
        for (let i = openList.length - 1; i >= 0; i--) {
            const trade = openList[i];
            // Ambil harga terakhir dari timeframe trade
            const tf = trade.tf || '5m';
            const lastPrice = signalsPerTF[tf]?.slice(-1)[0]?.price || trade.openPrice;
            trade.unrealized = trade.side === 'Buy' ? lastPrice - trade.openPrice : trade.openPrice - lastPrice;
            // Emit update
            io.emit('tradeUpdate', trade);
            // Close jika TP/SL
            if ((trade.side === 'Buy' && (lastPrice >= trade.targetPrice || lastPrice <= trade.stopLoss)) ||
                (trade.side === 'Sell' && (lastPrice <= trade.targetPrice || lastPrice >= trade.stopLoss))) {
                trade.closePrice = lastPrice;
                trade.result = trade.unrealized;
                tradeHistory[symbol].push(trade);
                io.emit('tradeClosed', trade);
                sendTelegramMessage(telegramMsg('CLOSED', trade));
                openList.splice(i, 1); // remove from openTrades
            }
        }
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


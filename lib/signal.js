const ti = require('technicalindicators');

// ================== ATR ==================
function computeATR(highs, lows, closes, period, changeATR) {
    const tr = [];
    for (let i = 0; i < highs.length; i++) {
        if (i === 0) {
            tr.push(highs[i] - lows[i]);
        } else {
            tr.push(Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            ));
        }
    }

    // ATR SMA method
    const atrSMA = ti.SMA.calculate({ period, values: tr });
    const atrSMAFull = Array(tr.length - atrSMA.length).fill(null).concat(atrSMA);

    // ATR true method
    const atrReal = ti.ATR.calculate({ high: highs, low: lows, close: closes, period });
    const atrRealFull = Array(tr.length - atrReal.length).fill(null).concat(atrReal);

    return changeATR ? atrRealFull : atrSMAFull;
}

// ================== EMA ==================
function computeEMA(values, period) {
    const ema = ti.EMA.calculate({ period, values });
    return Array(values.length - ema.length).fill(null).concat(ema);
}

// ================== SIGNALS ==================
function generateSignals(ohlc, params = {}) {
    const Periods = params.periods || 10;
    const Multiplier = params.multiplier || 3.0;
    const emaFilterLength = params.emaFilterLen || 200;
    const changeATR = params.changeATR ?? true;

    const highs = ohlc.map(d => d.high);
    const lows = ohlc.map(d => d.low);
    const closes = ohlc.map(d => d.close);
    const opens = ohlc.map(d => d.open);
    const hl2 = ohlc.map(d => (d.high + d.low) / 2);

    const atrArr = computeATR(highs, lows, closes, Periods, changeATR);
    const emaArr = computeEMA(closes, emaFilterLength);

    const up = [];
    const dn = [];
    const trend = [];

    for (let i = 0; i < closes.length; i++) {
        const atr = atrArr[i];
        const src = hl2[i];
        if (atr === null) {
            up.push(null);
            dn.push(null);
            trend.push(i === 0 ? 1 : trend[i - 1]);
            continue;
        }

        // Up/Down calculation like PineScript
        let upCalc = src - (Multiplier * atr);
        let dnCalc = src + (Multiplier * atr);

        if (i > 0) {
            const upPrev = up[i - 1] ?? upCalc;
            upCalc = closes[i - 1] > upPrev ? Math.max(upCalc, upPrev) : upCalc;

            const dnPrev = dn[i - 1] ?? dnCalc;
            dnCalc = closes[i - 1] < dnPrev ? Math.min(dnCalc, dnPrev) : dnCalc;
        }

        up.push(upCalc);
        dn.push(dnCalc);

        let trd = i === 0 ? 1 : trend[i - 1];
        if (trd === -1 && closes[i] > (dn[i - 1] ?? dnCalc)) trd = 1;
        else if (trd === 1 && closes[i] < (up[i - 1] ?? upCalc)) trd = -1;

        trend.push(trd);
    }

    return ohlc.map((d, i) => {
        if (i === 0) return {};

        // PineScript signals
        const buySignal = trend[i] === 1 && trend[i - 1] === -1;
        const sellSignal = trend[i] === -1 && trend[i - 1] === 1;

        const bullish = closes[i] > opens[i];
        const bearish = closes[i] < opens[i];
        const ema = emaArr[i];

        const sniperBuy = buySignal && ema && closes[i] > ema && bullish;
        const sniperSell = sellSignal && ema && closes[i] < ema && bearish;

        return {
            time: d.time,
            price: closes[i],
            buySignal,
            sellSignal,
            sniperBuy,
            sniperSell,
            trend: trend[i]
        };
    });
}

// ================== SIMULATOR ==================
function simulateTrades(signals, atrArr, tpMultiplier = 1) {
    const trades = [];
    let openTrade = null;

    for (let i = 0; i < signals.length; i++) {
        const s = signals[i];
        if (!s.time) continue;

        // Close existing trades if opposite signal or TP reached
        if (openTrade) {
            const atr = atrArr[i] || 0;
            if (openTrade.side === 'buy' && (s.price >= openTrade.openPrice + atr * tpMultiplier || s.sniperSell)) {
                openTrade.closePrice = s.price;
                openTrade.result = s.price - openTrade.openPrice;
                trades.push(openTrade);
                openTrade = null;
            } else if (openTrade.side === 'sell' && (s.price <= openTrade.openPrice - atr * tpMultiplier || s.sniperBuy)) {
                openTrade.closePrice = s.price;
                openTrade.result = openTrade.openPrice - s.price;
                trades.push(openTrade);
                openTrade = null;
            }
        }

        // Open new trades
        if (!openTrade) {
            if (s.sniperBuy) openTrade = { time: s.time, side: 'buy', openPrice: s.price };
            else if (s.sniperSell) openTrade = { time: s.time, side: 'sell', openPrice: s.price };
        }
    }

    // Close any remaining open trade at last price
    if (openTrade) {
        openTrade.closePrice = signals[signals.length - 1].price;
        openTrade.result = openTrade.side === 'buy'
            ? openTrade.closePrice - openTrade.openPrice
            : openTrade.openPrice - openTrade.closePrice;
        trades.push(openTrade);
    }

    return trades;
}

module.exports = { computeATR, computeEMA, generateSignals, simulateTrades };

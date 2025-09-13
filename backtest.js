const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { generateSignals } = require('./lib/signal');

(async () => {
    const file = process.argv[2] || 'data.csv';
    const raw = fs.readFileSync(file, 'utf8');
    const records = parse(raw, { columns: true });
    const ohlc = records.map(r => ({
        time: r.time,
        open: parseFloat(r.open),
        high: parseFloat(r.high),
        low: parseFloat(r.low),
        close: parseFloat(r.close),
        volume: r.volume ? parseFloat(r.volume) : 0
    }));
    const signals = generateSignals(ohlc);
    console.log("Last signals:", signals.slice(-10));
})();

const fs = require('fs');
const csv = fs.readFileSync('tools/offers_breakdown.csv', 'utf8');
const lines = csv.split('\n');

const applyStyle = (name) => {
    let stylized = name.toUpperCase();
    const endingWords = ['PACK', 'BUNDLE', 'PACKAGE', 'KIT', 'DEAL', 'VAULT', 'EDITION', 'HOARD'];
    const hasEnding = endingWords.some(w => stylized.endsWith(w));
    if (!hasEnding) {
        // Randomly choose PACK or BUNDLE based on length or just alternate
        if (stylized.length % 2 === 0) {
            stylized += ' PACK';
        } else {
            stylized += ' BUNDLE';
        }
    }
    return stylized;
};

for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');
    if (row[0] && row[1]) {
        row[1] = applyStyle(row[1]);
        lines[i] = row.join(',');
    }
}

fs.writeFileSync('tools/offers_breakdown.csv', lines.join('\n'));
console.log('Names stylized!');

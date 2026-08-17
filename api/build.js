const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const sourceDir = './src';
const outputDir = './dist';

// Create output directory if it doesn't exist
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

function obfuscateFile(filePath) {
    const code = fs.readFileSync(filePath, 'utf8');
    const obfuscatedCode = JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        numbersToExpressions: true,
        simplify: true,
        stringArrayShuffle: true,
        splitStrings: true,
        stringArrayThreshold: 0.75,
    });

    const relativePath = path.relative(sourceDir, filePath);
    const outputPath = path.join(outputDir, relativePath);

    // Create directory structure if needed
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    fs.writeFileSync(outputPath, obfuscatedCode.getObfuscatedCode());
}

function processDirectory(directory) {
    const files = fs.readdirSync(directory);

    files.forEach(file => {
        const filePath = path.join(directory, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            processDirectory(filePath);
        } else if (file.endsWith('.js')) {
            obfuscateFile(filePath);
        } else {
            // Copy non-JS files as-is
            const relativePath = path.relative(sourceDir, filePath);
            const outputPath = path.join(outputDir, relativePath);
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.copyFileSync(filePath, outputPath);
        }
    });
}

processDirectory(sourceDir);

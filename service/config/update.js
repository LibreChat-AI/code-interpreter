const path = require('path');
const { execSync } = require('child_process');
const { deleteNodeModules } = require('./helpers');

const config = {
    bun: process.argv.includes('-b'),
    local: process.argv.includes('-l'),
    skipGit: process.argv.includes('-g'),
};

const rootDir = path.resolve(__dirname, '..');

// @ts-ignore
console.green = text => console.log('\x1b[32m%s\x1b[0m', text);
// @ts-ignore
console.purple = text => console.log('\x1b[35m%s\x1b[0m', text);
// @ts-ignore
console.orange = text => console.log('\x1b[33m%s\x1b[0m', text);

(async () => {
    // @ts-ignore
    console.green(
        'Starting update script, this may take a minute or two depending on your system and network.',
    );

    const { bun } = config;
    // Delete node_modules
    deleteNodeModules(rootDir);

    // Clean npm cache
    // @ts-ignore
    console.purple('Cleaning npm cache...');
    execSync('npm cache clean --force', { stdio: 'inherit' });

    // Install dependencies
    // @ts-ignore
    console.purple('Installing dependencies...');
    if (bun) {
        // @ts-ignore
        console.purple('Installing with bun...');
    }
    execSync(bun ? 'bun install' : 'npm ci', { stdio: 'inherit' });

    // Build the project
    // @ts-ignore
    console.purple('Building the project...');
    if (bun) {
        // @ts-ignore
        console.purple('Building with bun...');
    }
    execSync(bun ? 'bun run build' : 'npm run build', { stdio: 'inherit' });

    // @ts-ignore
    console.green(
        'Your app is now up to date! Start the app with the following command:',
    );
    // @ts-ignore
    console.purple('npm run dev');
    // @ts-ignore
    console.orange(
        "Note: it's recommended to clear your browser cookies and localStorage for the app to ensure a fully clean installation.",
    );
})();

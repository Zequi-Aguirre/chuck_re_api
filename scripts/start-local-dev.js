const { spawn, execSync } = require('child_process');
const port = 8080;
const staticDomain = 'askzack-local.ngrok.app';

function killPort(port) {
    try {
        console.log(`🔪 Killing processes on port ${port}...`);
        const output = execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'pipe' });
        if (output.length) {
            console.log(`✅ Port ${port} cleared.`);
        } else {
            console.log(`ℹ️ No process was using port ${port}.`);
        }
    } catch (error) {
        console.log(`⚠️ Could not kill port ${port}, maybe it was already free.`);
    }
}

function killNgrok() {
    try {
        console.log(`🔪 Killing existing ngrok processes...`);
        execSync(`pkill -f ngrok`);
        console.log(`✅ Ngrok processes killed.`);
    } catch (error) {
        console.log(`ℹ️ No existing ngrok processes found.`);
    }
}

async function start() {
    // Ensure clean state
    killPort(port);
    killNgrok();

    console.log("🚀 Starting backend...");

    const serverProcess = spawn('npm', ['run', 'dev-be'], {
        stdio: 'inherit',
        shell: true,
    });

    await new Promise((res) => setTimeout(res, 4000));

    console.log(`🌐 Launching ngrok at static domain: https://${staticDomain}`);

    const ngrokProcess = spawn('ngrok', ['http', `${port}`], {
        stdio: 'inherit',
        shell: true,
    });

    ngrokProcess.on('exit', (code) => {
        console.log(`Ngrok process exited with code ${code}`);
    });
}

start();
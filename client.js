const WebSocket = require('ws');
const http = require('http');
const bonjour = require('bonjour')();
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { url } = require('inspector');
const execAsync = promisify(exec);

/**
 *  VERSION CONTROL
 *  All version numbers associated with this build originate from 
 */
const pgm = {
    ver: {
        maj: 3,
        min: 1,
        ptch: 0
    },
    build: [
        { ver: '3.0.0', rel: '03-05-26' },
        { ver: '3.1.0', rel: '03-22-26' }
    ]
};
const version = `${pgm.ver.maj}.${pgm.ver.min}.${pgm.ver.ptch}`;

/** Version NOTES
 * v3.0.0
 *      - Added dynamic library selection when launching ndi_receiver.
 *      - Re-designed console logging to:
 *          console.log('⸻   ⸻   ⸻...
 *          console.log(`⫷ ${ipAddr} ⫸  ╮`);
 *          console.log(`                  ╰⸺  ▶ ${message.toUpperCase()}`);
 *          if (data) {
 *              console.log(data);
 *          }
 *          console.log(' ');
 *          - Added
 *              Overhead line 
 *              IP Address (for possible future all-in-one log dashboards)
 *              Arrow pointing to the main message
 *              Data only if included
 * v3.1.0
 *      - Cleaned up launching overlay display. 
 *          Switched to one Chromium instance for the duration of the process. 
 *          This was made possible by using full screen mode instead of kiosk as kiosk remained on top.
 *          When Chromium is in full screen and the ndi_receiver is spawned, the ndi_receiver opens on top
 *          Added new elements to the overlay display
 *              Ping animation: (top left side) signaling the device is attempting to reach the server.
 *              Loading spinner: (top right side) displays when attempting to connect to a source.
 *          Added commands to display server websocket to utilize the 'always open' Chromium instance, and to activate added elements.
 *              ndi-init: Shows the loading spinner element.
 *              ndi-started: Clears all elements from the display. Sends after successful connection to NDI source.
 *      - Switch the Raspberry Pi display backend to X11
 *          This gives FULL control of the desktop environment.
 *          Added startup actions including moving the cursor to different points on the screen to ensure the taskbar hides automatically
 *              (Might switch to no task bar in future releases, as it's not really needed)
 *          The startup process is contained in one function called 'displayStartup()'
 *      - New function, killNdiReceiver(), used to terminate ndi_receiver. There were numerous commands scattered everywhere. 
 */

/** END of - VERSION CONTROL **/

function startupConsoleLog() {
    console.log(`
════════════════════════════════════════════════════════════════
  ⌈▔∖ ⌈▔⌈▔▔▔▔∖⌈▔▔▔▔∖(-)   ⌈▔▔∖/▔▔|           (-) ▔▏           
  ⏐  ∖⏐ ⏐ ⌈▔| ⏐ ⌈-) ⌈▔|   ⏐ ⌈∖/| ⏐/▔▔▔∖⌈▔'▔▔∖⌈▔|▏ ▔/▔▔▔∖⌈▔'▔▔|
  ⏐ ⌈∖  ⏐ ⌊_| ⏐  __/⏐ ⏐▔▔▔⏐ ⏐  ⏐ ⏐ (-) ⏐ ⌈▔⏐ ⏐ ⏐▏ ⎡▏(-) ⏐ ⌈▔▔             
  ⌊_| ∖_⌊____/⌊_|   ⌊_|▔▔▔⌊_|  ⌊_|∖___/⌊_| ⌊_⌊_|∖__∖___/⌊_|              𓀡
                           
                                     𝘝𝘦𝕣𝕤𝕚𝕠𝕟   ⸻      ${version}
  N D P i - M O N I T O R            𝔹𝕦𝕚𝕝𝕕     ⸻      ${pgm.build.find(v => v.ver === version).rel || 'WIP'}
════════════════════════════════════════════════════════════════
`);
}

const CRLFArray = (string = '') => { return string.split(/\r?\n/); }

function consoleLog(message = 'SYSTEM UPDATE', data, error) {
    const ipAddr = getLocalIP();

    if (error) {
        console.log('⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻ ');
        console.log(`⫷ ${ipAddr} ⫸ 🔴 ERROR`);
        console.log(`${message.toUpperCase()}`);
        console.log(error);
        if (data) {
            console.log(`DATA:`);
            console.log(data);
        }
        console.log(' ');
    } else {
        console.log('⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻ ');
        console.log(`⫷ ${ipAddr} ⫸  ╮`);
        console.log(`                  ╰⸺  ▶ ${message.toUpperCase()}`);
        if (data) {
            console.log(data);
        }
        console.log(' ');
    }
}

function getDeviceId() {
    try {
        const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
        const serialMatch = cpuinfo.match(/Serial\s*:\s*([0-9a-f]+)/i);
        if (serialMatch) {
            return serialMatch[1];
        }
    } catch (error) {
        consoleLog('Error Reating Serial Number', null, error);
    }
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
            if (isIPv4 && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

function cecPowerOn() {
    let success = false;
    consoleLog(`(↑↓) cec command out: 'on 0' && 'as'`);
    exec('echo "on 0" | cec-client -s -d 1 && echo "as" | cec-client -s -d 1', (e,o,err) => {
        if (e) {
            consoleLog('[ERROR] CEC', null, { Message: err || 'No Error String Output' });
        } else {
            const res = CRLFArray(o);
            if (res.length > 0) res.forEach( (line) => {console.log(`(↓↓)[ EXEC STDOUT ] ⸺  ▶ ${line}`)} );
            success = true;
        }
        if (success) {
            consoleLog('[sent] CEC', stdout);
            return { success: true };
        }
    });
}

function cecPowerOff() {
    let success = false;
    consoleLog(`(↑↓) cec command out: 'standby 0'`);
    exec('echo "standby 0" | cec-client -s -d 1', (e,o,err) => {
        if (e) {
            consoleLog('[ERROR] CEC', null, { Message: err || 'No Error String Output' });
        } else {
            const res = CRLFArray(o);
            if (res.length > 0) res.forEach( (line) => {console.log(`(↓↓)[ EXEC STDOUT ] ⸺  ▶ ${line}`)} );
            success = true;
        }
        if (success) {
            consoleLog('[sent] CEC', stdout);
            return { success: true };
        }
    });
}

class NDPiClient {
    constructor() {
        startupConsoleLog();
        this.deviceId = getDeviceId();
        this.pathDeviceName = path.join(__dirname, 'client-device-name.txt');
        this.deviceName = this.loadDeviceName();
        this.localIP = getLocalIP();
        this.commandPort = 3001;
        this.displayPort = 8080;
        this.mdnsPort = 3002;
        this.currentSource = null;
        this.targetSource = null;  // The source to connected to
        this.displayMode = 'overlay'; // can either be 'blank' or 'overlay'
        this.displayClients = new Set();
        this.ndiReconnectTimer = null;
        
        /*
         *  NDI stream info 
         */
        this.ndiInfo = {
            resolution: null,
            framerate: null,
            connectedAt: null,
            displayResolution: null,
            displayName: null
        };
        
        this.serverWs = null;
        this.serverWsReconnectTimer = null;
        this.serverAddress = null;
        
        this.configPath = path.join(__dirname, 'client-state.json');

        this.loadState();

        consoleLog('starting up...', {
            Service: `NDPi Monitor Client v${pgm.ver.maj}.${pgm.ver.min}`,
            DeviceId: this.deviceId,
            DeviceName: this.deviceName,
            LocalIp: this.localIP
        });

        this.startDisplayServer();
        this.startCommandServer();
        this.startMDNSBroadcast();

        setTimeout(() => {
            this.displayStartup();
        }, 1000);
    }

    displayStartup() {
        setTimeout(() => {
            exec('xdotool mousemove 3840 2160');
            setTimeout(() => {
                exec('xdotool mousemove 3840 0');
                setTimeout(() => {
                    if (this.targetSource) {
                        this.startNDIReceiver(this.targetSource);
                        setTimeout(() => {
                            this.launchDisplayKiosk();
                        }, 8000);
                    } else {
                        this.launchDisplayKiosk();
                    }
                }, 2000);   // 3rd.     If source is set, start NDI Receiver - wait 8s - launch display, else launch display.
            }, 500);            // 2nd.     Move cursor to top right (activate autohide taskbar) Then ^^
        }, 500);                    // 1st.     Move cursor to bottom right (trigger autohide taskbar) Then ^^^
    }

    loadDeviceName() {
        const defaultDeviceName = 'NDPi Client';
        try {
            if (fs.existsSync(this.pathDeviceName)) {
                return fs.readFileSync(this.pathDeviceName, 'utf8').trim();
            } else {
                this.writeDeviceName(defaultDeviceName);
                return defaultDeviceName;
            }
        } catch (e) {
            this.writeDeviceName(defaultDeviceName);
            return defaultDeviceName;
        }
    }

    writeDeviceName(name) {
        fs.writeFileSync(this.pathDeviceName, name, 'utf8');
        consoleLog('[UPDATED] client-device-name.txt', { DeviceName: name });
    }

    saveDeviceName(name) {
        this.deviceName = name;
        writeDeviceName(name);
        this.updateMDNSBroadcast();
    }

    loadState() {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                
                consoleLog('loading Previous State', data);
                
                if (data.sourceName && data.sourceName !== 'None') {
                    this.targetSource = data.sourceName;
                    this.currentSource = data.sourceName;
                }
                
                // Remember server address for reconnection
                if (data.serverAddress) {
                    this.serverAddress = data.serverAddress;
                    setTimeout(() => this.connectToServer(data.serverAddress), 2000);
                }
            }
        } catch (error) {
            consoleLog('[ERROR] device settings', null, error);
            
        }
    }

    saveState(commandInfo = {}) {
        const state = {
            sourceName: this.targetSource || 'None',
            displayMode: this.displayMode,
            commandedBy: commandInfo.user || this.lastCommandUser || 'unknown',
            commandedAt: commandInfo.timestamp || new Date().toISOString(),
            serverAddress: this.serverAddress,
            deviceName: this.deviceName
        };
        
        this.lastCommandUser = state.commandedBy;
        
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(state, null, 2), 'utf8');
            consoleLog('[Updated] Device Settings', state);
        } catch (error) {
            consoleLog('[error] updating device state', null, error);
        }
    }

    connectToServer(serverAddress) {
        if (!serverAddress || serverAddress === 'localhost') return;
        
        this.serverAddress = serverAddress;
        
        // Clean up existing connection
        if (this.serverWs) {
            try {
                this.serverWs.close();
            } catch {}
            this.serverWs = null;
        }
        
        if (this.serverWsReconnectTimer) {
            clearTimeout(this.serverWsReconnectTimer);
            this.serverWsReconnectTimer = null;
        }
        
        const wsUrl = `ws://${serverAddress}/ws/client`;
        const reconnectionTimeout = 5000;
        const sendStatusInterval = 5000;

        consoleLog('[Establishing connection] ndpi server',{ WebSocket: wsUrl });
        
        try {
            this.serverWs = new WebSocket(wsUrl);
            
            this.serverWs.on('open', () => {
                consoleLog('[connected] ndpi server', { details: `Sending status updates every ${sendStatusInterval / 1000} seconds.` });

                // Start/Repeat Status Updates to Server
                this.sendStatusToServer();
                this.statusInterval = setInterval(() => {
                    this.sendStatusToServer();
                }, sendStatusInterval);
                
            });
            
            this.serverWs.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    consoleLog('(↓↑) ndpi Server', message);
                    this.handleServerMessage(message);
                } catch (error) {
                    consoleLog('(↓↑) ndpi server', data, error);
                }
            });
            
            this.serverWs.on('close', () => {
                consoleLog('[disconnected] ndpi server', { ReconnectingIn: reconnectionTimeout / 1000 });
                if (this.statusInterval) {
                    clearInterval(this.statusInterval);
                    this.statusInterval = null;
                }
                
                this.serverWsReconnectTimer = setTimeout(() => {
                    this.connectToServer(this.serverAddress);
                }, reconnectionTimeout);
            });
            
            this.serverWs.on('error', (error) => {
                consoleLog('[connection error] ndpi server', null, error);
            });
            
        } catch (error) {
            consoleLog('[connection failed] ndpi server', {ReconnectTimeout: 5000}, error);
            
            this.serverWsReconnectTimer = setTimeout(() => {
                this.connectToServer(serverAddress);
            }, 5000);
        }
    }

    getSystemStats() {
        const stats = {
            cpu: 0,
            memory: { used: 0, total: 0, percent: 0 },
            temperature: 0,
            uptime: 0
        };
        
        try {
            // CPU usage - read from /proc/stat
            const cpuData = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/);
            const idle = parseInt(cpuData[4]);
            const total = cpuData.slice(1, 8).reduce((a, b) => a + parseInt(b), 0);
            
            if (this.lastCpuStats) {
                const idleDiff = idle - this.lastCpuStats.idle;
                const totalDiff = total - this.lastCpuStats.total;
                stats.cpu = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
            }
            this.lastCpuStats = { idle, total };
            
            // Memory usage - read from /proc/meminfo
            const memInfo = fs.readFileSync('/proc/meminfo', 'utf8');
            const memTotal = parseInt(memInfo.match(/MemTotal:\s+(\d+)/)[1]) / 1024; // MB
            const memAvailable = parseInt(memInfo.match(/MemAvailable:\s+(\d+)/)[1]) / 1024; // MB
            stats.memory.total = Math.round(memTotal);
            stats.memory.used = Math.round(memTotal - memAvailable);
            stats.memory.percent = Math.round((stats.memory.used / stats.memory.total) * 100);
            
            // Temperature - read from thermal zone
            const tempFile = '/sys/class/thermal/thermal_zone0/temp';
            if (fs.existsSync(tempFile)) {
                stats.temperature = parseInt(fs.readFileSync(tempFile, 'utf8')) / 1000;
            }
            
            // System uptime
            const uptimeSeconds = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
            stats.uptime = Math.floor(uptimeSeconds);
            
        } catch (error) {
            // Silently fail - stats will be 0
        }
        
        return stats;
    }

    sendStatusToServer() {
        if (!this.serverWs || this.serverWs.readyState !== WebSocket.OPEN) return;

        const streamUptime = this.ndiInfo.connectedAt 
            ? Math.floor((Date.now() - new Date(this.ndiInfo.connectedAt).getTime()) / 1000)
            : 0;
        
        const systemStats = this.getSystemStats();
        
        const status = {
            type: 'client-status',
            deviceId: this.deviceId,
            deviceName: this.deviceName,
            ip: this.localIP,
            currentSource: this.currentSource || 'None',
            targetSource: this.targetSource || 'None',
            displayMode: this.displayMode,
            ndiInfo: {
                resolution: this.ndiInfo.resolution,
                framerate: this.ndiInfo.framerate,
                displayResolution: this.ndiInfo.displayResolution,
                displayName: this.ndiInfo.displayName,
                connectedAt: this.ndiInfo.connectedAt,
                uptime: streamUptime
            },
            systemStats: systemStats,
            status: this.ndiProcess ? 'streaming' : 'idle'
        };
        
        try {
            this.serverWs.send(JSON.stringify(status));
        } catch (error) {
            consoleLog('[failed] status update to server', null, error);
        }
    }

    handleServerMessage(message) {

        const handled = () => {
            consoleLog(`[handled] ${message.type}`);
        }
        
        switch (message.type) {
            case 'set-source':
                this.setNDISource(message.sourceName, {
                    user: message.user,
                    timestamp: message.timestamp,
                    serverAddress: message.serverAddress
                });
                handled();
                break;
                
            case 'overlay':
                this.showOverlay({ user: message.user });
                handled();
                break;
                
            case 'blank':
                this.showBlank({ user: message.user });
                handled();
                break;
                
            case 'reboot':
                handled();
                setTimeout(() => this.systemReboot(), 1000);
                break;
                
            case 'shutdown':
                handled();
                setTimeout(() => this.systemShutdown(), 1000);
                break;
                
            case 'set-network':
                consoleLog('[unhandled] Network Setting Feature NOT ACTIVE...', message, { error: 'Network config feature not implemented.' });
                //this.applyNetworkSettings(message.config);
                break;
                
            case 'ping':
                consoleLog('(↑↓) ndpi Server: ws', { data: 'pong' });
                this.serverWs.send(JSON.stringify({ type: 'pong', deviceId: this.deviceId }));
                break;
            default:
                consoleLog(`[unhandled] ${message.type}`);
                break;
        }
    }

    parseNDIInfo(output) {

        CRLFArray(output).forEach((stdout) => {
            console.log(`(↓↓)[ NDI ] ⸺  ▶ ${stdout}`);
        });

        /*
        outputArry.forEach((stdout) => {
            console.log(`(↓↓)[ NDI ] ⸺  ▶ ${stdout}`);
        });
        */
        const videoMatch = output.match(/(?:Video|Source):\s*(\d+)x(\d+)\s*@\s*(\d+(?:\.\d+)?)/i);
        if (videoMatch) {
            this.ndiInfo.resolution = `${videoMatch[1]}x${videoMatch[2]}`;
            this.ndiInfo.framerate = parseFloat(videoMatch[3]);
        }
        
        const displayMatch = output.match(/(?:Display|Scaled to):\s*(\d+)x(\d+)/i);
        if (displayMatch) {
            this.ndiInfo.displayResolution = `${displayMatch[1]}x${displayMatch[2]}`;
        }
        
        const monitorMatch = output.match(/Monitor:\s*(.+)/i);
        if (monitorMatch) {
            this.ndiInfo.displayName = monitorMatch[1].trim();
        }
        
        if (!this.ndiInfo.resolution) {
            const resMatch = output.match(/(\d{3,4})x(\d{3,4})/);
            if (resMatch) {
                this.ndiInfo.resolution = `${resMatch[1]}x${resMatch[2]}`;
            }
        }
        
        if (!this.ndiInfo.framerate) {
            const fpsMatch = output.match(/(\d+(?:\.\d+)?)\s*fps|@\s*(\d+(?:\.\d+)?)/i);
            if (fpsMatch) {
                this.ndiInfo.framerate = parseFloat(fpsMatch[1] || fpsMatch[2]);
            }
        }
        
        if (output.includes('Found target source') || output.includes('Connected to:')) {
            if (!this.ndiInfo.connectedAt) {
                this.ndiInfo.connectedAt = new Date().toISOString();
            }
        }
    }

    startDisplayServer() {
        const displayServer = http.createServer((req, res) => {

            let filePath;
            const assetsDir = path.join(__dirname, 'Assets');
            
            if (req.url === '/' || req.url === '/display.html') {
                filePath = path.join(__dirname, 'display.html');
            } else if (req.url.startsWith('/assets/')) {
                filePath = path.join(assetsDir, req.url.substring(8));
            } else {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            
            const ext = path.extname(filePath);
            const contentTypes = {
                '.html': 'text/html',
                '.svg': 'image/svg+xml',
                '.css': 'text/css',
                '.js': 'application/javascript'
            };
            
            fs.readFile(filePath, (err, data) => {
                let code;
                if (err) {
                    code = 404;
                } else {
                    code = 200;
                }

                consoleLog('(↓↑) Display Server: rest API', {
                    req: {
                        url: `${req.url}`,
                        method: `${req.method}`,
                        headers: req.headers ?? {},
                        body: req.body ?? {}
                    },
                    res: { status: code }
                });

                if (err) {
                    res.writeHead(404);
                    res.end('File not found: ' + filePath);
                    return;
                }
                res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
                res.end(data);
            });
        });

        // WebSocket server for display control
        this.displayWss = new WebSocket.Server({ server: displayServer });
        
        this.displayWss.on('connection', (ws) => {
            
            this.displayClients.add(ws);
            
            // Send current state
            consoleLog('(↑↓) Display Server: ws', { type: `show-${this.displayMode}` });
            ws.send(JSON.stringify({ type: `show-${this.displayMode}` }));
            
            ws.on('close', () => {
                this.displayClients.delete(ws);
                consoleLog('[disconnected] display server: ws');
            });

            ws.on('error', (error) => {
                consoleLog('[failed] display server: ws', null, error);
            });
        });

        displayServer.listen(this.displayPort, () => {
            consoleLog('[online] display server', {url: `http://${this.localIP}:${this.displayPort}`});
        });
    }

    broadcastToDisplay(message) {
        const data = JSON.stringify(message);

        this.displayClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    }

    launchDisplayKiosk() {

        //const instanceCheck = `pgrep -f "chromium.*localhost:${this.displayPort}" 2`;
        const instanceCheck = 'pgrep -f "chromium" 2>/dev/null';
        const newInstance = `/usr/bin/chromium \
            --disable-popup-blocking \
            --hide-crash-restore-bubble \
            --aggressive-cache-discard \
            --disable-infobars \
            --disable-session-crashed-bubble \
            --disable-component-extensions-with-background-pages \
            --no-first-run \
            --disable-default-apps \
            --disable-translate \
            --hide-scrollbars \
            --disable-features=TranslateUI \
            --noerrdialogs \
            --disable-web-security \
            --touch-events=enabled \
            --start-fullscreen \
            http://localhost:${this.displayPort}/ &`;

           // exec(newInstance);
           // console.log(instanceCheck);

        exec(instanceCheck, (err, stdout, stderr) => {
            const stdArry = CRLFArray(stdout);
            console.log(stdArry);
            console.log(stdArry.length);
            if (stdArry.length < 3) {
                consoleLog('launching new overlay instance');
                exec(newInstance, (error, stdout, stderr) => {
                    if (error) {
                        consoleLog('[failed] launching overlay instance', stdout, stderr);
                    }
                });
            } else if (err) {
                consoleLog('[ERROR] CHECKING OVERLAY INSTANCE', stdArry, stderr);
            }
        });

        
        /*  OLD COMMAND V2
        exec('pkill -f "chromium" 2>/dev/null', () => {

            
            // Launch Chromium in kiosk mode
            const chromiumCmd = `WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 chromium --kiosk --disable-infobars --no-first-run --disable-translate --disable-features=TranslateUI --start-fullscreen --ozone-platform=wayland --noerrdialogs --disable-session-crashed-bubble http://localhost:${this.displayPort}/ &`;
            */
            
            /**
             * Does Not Use Wayland
             * * * WORKS
            const chromiumCmd = `/usr/bin/chromium \
                --kiosk \
                --disable-infobars \
                --disable-session-crashed-bubble \
                --disable-component-extensions-with-background-pages \
                --no-first-run \
                --disable-default-apps \
                --disable-translate \
                --hide-scrollbars \
                --disable-features=TranslateUI \
                --noerrdialogs \
                --disable-web-security \
                --touch-events=enabled \
                http://localhost:${this.displayPort}/ &
            `;

            
            exec(chromiumCmd, (error) => {
                if (error) {
                    consoleLog('[failed] overlay instance', null, error)
                }
            });
        });
        */
    }

    startCommandServer() {
        // Create HTTP server with REST API endpoints
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://${req.headers.host}`);
            
            // CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            
            if (req.method === 'OPTIONS') {
                consoleLog('(↓↑) command server: rest api', {
                    req: {
                        url: `${req.url}`,
                        method: `${req.method}`,
                        headers: req.headers ?? {},
                        body: req.body ?? {}
                    },
                    res: {status: 200}
                });
                res.writeHead(200);
                res.end();
                return;
            }
            
            // REST API endpoints
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);

                req.on('end', async () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    consoleLog('(↓↑) command server: rest api', {
                        req: {
                            url: `${req.url}`,
                            method: `${req.method}`,
                            headers: req.headers ?? {},
                            body: JSON.parse(body) ?? {}
                        },
                        res: {status: 200}
                    });

                    const handled = () => {
                        consoleLog(`[handled] ${url.pathname}`);
                    }
                    
                    switch (url.pathname) {
                        case '/api/overlay':
                            this.showOverlay();
                            handled();

                            res.end(JSON.stringify({ success: true, message: 'Overlay displayed' }));
                            break;
                        case '/api/blank':
                            this.showBlank();
                            handled();

                            res.end(JSON.stringify({ success: true, message: 'Blank screen displayed' }));
                            break;
                        case '/api/source':
                            try {
                                const data = JSON.parse(body);
                                this.setNDISource(data.sourceName,{
                                    user: 'http',
                                    timestamp: Date.now()
                                });
                                handled();

                                res.end(JSON.stringify({ success: true, message: `Source set to ${data.sourceName}` }));
                            } catch (e) {
                                consoleLog(`[unhandled] ${url.pathname}`, body, e);

                                res.end(JSON.stringify({ error: 'Invalid JSON body', data: JSON.stringify(body) }));
                            }
                            break;
                        case '/api/cec/on':
                            const successCecOn = await cecPowerOn();
                            if (successCecOn === undefined) {
                                consoleLog(`[handel Unknown] ${url.pathname}`, null, {CEC_success: successCecOn});

                                res.end(JSON.stringify({ success: true, message: 'TV Power On' }));
                            } else if (!successCecOn.success) {
                                handled();

                                res.end(JSON.stringify({ success: false, message: 'TV Power On Failed' }));
                            } else if (successCecOn.success) {
                                handled();

                                res.end(JSON.stringify({ success: true, message: 'TV Power On' }));
                            }
                            break;
                        case '/api/cec/standby':
                            const successCecOff = await cecPowerOff();
                            if (successCecOff === undefined) {
                                consoleLog(`[handel Unknown] ${url.pathname}`, null, {CEC_success: successCecOff});

                                res.end(JSON.stringify({ success: true, message: 'TV Power Off' }));
                            } else if (!successCecOff.success) {
                                handled();

                                res.end(JSON.stringify({ success: false, message: 'TV Power Off Failed' }));
                            } else if (successCecOff.success) {
                                handled();

                                res.end(JSON.stringify({ success: true, message: 'TV Power Off' }));
                            }
                            break;
                        case '/api/deviceName':
                            try {
                                const currentDeviceName = this.deviceName;
                                const data = JSON.parse(body);
                                this.saveDeviceName(data.deviceName);
                                handled();
                                res.end(JSON.stringify({
                                    success: true,
                                    message: `Device name updated.`,
                                    updates: {
                                        deviceName: {
                                            previous: currentDeviceName,
                                            new: data.deviceName
                                        }
                                    }
                                }));
                            } catch (e) {
                                consoleLog(`[unhandled] ${url.pathname}`, body, e);
                                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                            }
                            break;
                        default:
                            consoleLog(`[unhandled] ${url.pathname}`, {details: 'Path Not Defined'});
                            res.end(JSON.stringify({ error: 'Not found' }));
                    }
                });
                return;
            }
            
            // GET - return status
            consoleLog('(↓↑) command server: rest api', {
                req: {
                    url: `${req.url}`,
                    method: `${req.method}`,
                    headers: req.headers ?? {},
                    body: req.body ?? {}
                },
                res: {status: 200}
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                deviceId: this.deviceId,
                deviceName: this.deviceName,
                ip: this.localIP,
                status: 'online',
                currentSource: this.currentSource,
                displayMode: this.displayMode || 'overlay',
                type: 'Certified NDPi Monitor'
            }));
        });

        this.wss = new WebSocket.Server({ server });

        this.wss.on('connection', (ws) => {

            ws.on('message', (message) => {
                try {
                    const command = JSON.parse(message);
                    consoleLog('(↓↑) command server: ws');
                    this.handleCommand(command, ws);
                } catch (error) {
                    consoleLog('incoming command: websocket ', {Message: message}, error);
                    ws.send(JSON.stringify({ error: 'Invalid command format' }));
                }
            });

            ws.on('close', () => {
                consoleLog('[disconnected] command server: ws');
            });

            ws.on('error', (error) => {
                consoleLog('[connection error] command server: ws', null, error);
            });
        });

        server.listen(this.commandPort, () => {
            consoleLog('[online] command server', {url: `http://${this.localIP}:${this.displayPort}`});
        });
    }

    handleCommand(command, ws) {

        if (command.serverAddress) {
            if (command.serverAddress !== this.serverAddress) {
                consoleLog('[handled][updated] server ip address', { ReconnectingIn: 0.5 });
                this.serverAddress = command.serverAddress;
                setTimeout(() => this.connectToServer(command.serverAddress), 500);
            } else {
                consoleLog('[unhandled][no change] server ip address');
            }
        }

        const commandInfo = {
            user: command.user || 'unknown',
            timestamp: command.timestamp || new Date().toISOString()
        };

        const handled = () => {
            consoleLog(`[handled] ${command.type}`);
        }

        switch (command.type) {
            case 'set-source':
                this.setNDISource(command.sourceName, commandInfo);
                handled();
                ws.send(JSON.stringify({ success: true, message: `Source set to ${command.sourceName}` }));
                break;

            case 'rename':
                this.saveDeviceName(command.newName);
                handled();
                ws.send(JSON.stringify({ success: true, message: `Renamed to ${command.newName}` }));
                break;

            case 'show-overlay':
            case 'overlay':
                this.showOverlay(commandInfo);
                handled();
                ws.send(JSON.stringify({ success: true, message: 'Overlay displayed' }));
                break;

            case 'show-blank':
            case 'blank':
                this.showBlank(commandInfo);
                handled();
                ws.send(JSON.stringify({ success: true, message: 'Blank screen displayed' }));
                break;

            case 'shutdown':
                ws.send(JSON.stringify({ success: true, message: 'Shutting down...' }));
                handled();
                setTimeout(() => this.systemShutdown(), 1000);
                break;

            case 'reboot':
                ws.send(JSON.stringify({ success: true, message: 'Rebooting...' }));
                handled();
                setTimeout(() => this.systemReboot(), 1000);
                break;

            case 'ping':
                ws.send(JSON.stringify({ success: true, type: 'pong', deviceId: this.deviceId }));
                consoleLog('(↑↓) command server: ws', { data: 'pong' });
                break;

            case 'get-status':
                ws.send(JSON.stringify({
                    success: true,
                    deviceId: this.deviceId,
                    deviceName: this.deviceName,
                    ip: this.localIP,
                    currentSource: this.currentSource,
                    displayMode: this.displayMode || 'overlay',
                    status: 'online'
                }));
                handled();
                break;

            default:
                consoleLog(`[unhandled] ${command.type}`);
                ws.send(JSON.stringify({ error: `Unknown command: ${command.type}` }));
        }
    }

    get_mdnsService() {
        // This is the mDNS Service Object.
        this.localIP = getLocalIP();
        // Service Object
        return {
            name: `ndpi-client-${this.deviceId}`,
            type: 'ndpi-monitor-client',
            port: this.mdnsPort,
            txt: {
                deviceId: `${this.deviceId}`,
                deviceName: `${this.deviceName}`,
                ip: `${this.localIP}`,
                commandPort: this.commandPort.toString(),
                type: 'Certified NDPi Monitor',
                status: 'online',
                version: String(version)
            }
        };
    }

    startMDNSBroadcast() {
        this.updateMDNSBroadcast();

        const mdnsRepeatInterval = 60000;
        setInterval(() => { this.updateMDNSBroadcast(); }, mdnsRepeatInterval);
    }

    updateMDNSBroadcast() {
        let consoleMessage = '(↑↑) mdns';

        if (this.mdnsService) {
            this.mdnsService.stop();
        } else {
            consoleMessage += ' init';
        }

        const service = this.get_mdnsService();
        
        this.mdnsService = bonjour.publish(service);
        consoleLog(consoleMessage, service);
    }

    killNdiReceiver() {
        if (this.ndiProcess) {
            //require('child_process').execSync('pkill -9 chromium 2>/dev/null || true');
            //this.launchDisplayKiosk();
            //setTimeout(() => {
                try {
                    this.ndiProcess.kill('SIGKILL'); // Use SIGKILL for immediate termination
                    consoleLog('[ ndi ] ⸺  ▶ [term 1 of 2]');
                } catch (e) {}

                // Kill any orphaned NDI processes
                try {
                    require('child_process').execSync('pkill -9 ndi_receiver_v2 2>/dev/null || true');
                    //exec('pkill -9 ndi_receiver_v2 2>/dev/null || true');
                    //require('child_process').execSync('pkill -9 chromium 2>/dev/null || true');
                } catch (e) {}

                this.ndiProcess = null;
                this.ndiInfo = {
                    resolution: null,
                    framerate: null,
                    connectedAt: null,
                    displayResolution: null,
                    displayName: null
                };
            //}, 5000);
        }
        return true;
    }

    setNDISource(sourceName, commandInfo = {}) {
        if (this.ndiReconnectTimer) {
            clearTimeout(this.ndiReconnectTimer);
            this.ndiReconnectTimer = null;
        }
        
        this.currentSource = sourceName;
        this.targetSource = sourceName;
        
        // Save server address if provided
        if (commandInfo.serverAddress) {
            this.serverAddress = commandInfo.serverAddress;

            if (!this.serverWs || this.serverWs.readyState !== WebSocket.OPEN) {
                this.connectToServer(commandInfo.serverAddress);
            }
        }
        
        this.saveState(commandInfo);
        
        // If source is None or empty, just stop
        if (!sourceName || sourceName === 'None') {
            this.targetSource = null;
            this.sendStatusToServer();
            this.launchDisplayKiosk();
            setTimeout(() => {
                this.killNdiReceiver();
            }, 1000);
            return;
        }
        
        this.startNDIReceiver(sourceName);
    }
    
    startNDIReceiver(sourceName) {
        /*
        const killPr = this.killNdiReceiver();
        if (!killPr) console.log('************ NDI RECEIVER process NOT terminated!');
        */
        consoleLog('[Establishing connection] NDI');
        this.broadcastToDisplay({ type: 'ndi-init' });
        
        setTimeout(() => {
            this._startNDIReceiverInternal(sourceName);
        }, 200);
    }
    
    _startNDIReceiverInternal(sourceName) {

        const killPr = this.killNdiReceiver();
        if (!killPr) console.log('************ NDI RECEIVER process NOT terminated!');

        const receiverPath = path.join(__dirname, 'ndi_receiver_v2');
        if (!fs.existsSync(receiverPath)) {
            consoleLog('[ERROR] ndi', { Path: receiverPath }, { error: 'Receiver path not found.' });
            this.scheduleReconnect();
            this.broadcastToDisplay({ type: `show-${this.displayMode}` });
            return;
        }
        
        const { spawn } = require('child_process');

        console.log(`(↑↓)[ NDI ] ⸺  ▶ [INIT]`, {SourceName: sourceName});

        this.ndiProcess = spawn(receiverPath, [sourceName], {
            env: {
                ...process.env,
                DISPLAY: ':0',
                XAUTHORITY: '/home/ndpi-client/.Xauthority',
                LD_LIBRARY_PATH: '/opt/NDI SDK for Linux/lib/aarch64-rpi4-linux-gnueabi:' + (process.env.LD_LIBRARY_PATH || '')
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        this.ndiProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            this.parseNDIInfo(output);
            if (output.includes('Connected to:')) {
                this.broadcastToDisplay({ type: 'ndi-started' });
            }
            this.sendStatusToServer();
        });
        
        this.ndiProcess.stderr.on('data', (data) => {
            const output = data.toString().trim();
            CRLFArray(output).forEach((line) => {
                console.log('(X)[ NDI ] ⸺  ▶ [ERROR]: ', output);
            });
        });
        
        this.ndiProcess.on('close', (code) => {
            consoleLog('[ ndi ] ⸺  ▶ [disconnected]', {
                Code: `${code}`
            });
            this.ndiProcess = null;
            this.ndiInfo.connectedAt = null;
            this.broadcastToDisplay({ type: `show-${this.displayMode}` });
            this.sendStatusToServer();
            
            // Schedule reconnect if we still have a target source
            this.scheduleReconnect();
        });
        
        this.ndiProcess.on('error', (error) => {
            consoleLog('[error] ndi', null, error);
            this.ndiProcess = null;
            this.scheduleReconnect();
        });
    }
    
    scheduleReconnect() {
        // Only reconnect if we have a target source and aren't already trying
        if (!this.targetSource || this.targetSource === 'None' || this.ndiReconnectTimer) {
            return;
        }
        this.broadcastToDisplay({ type: 'ndi-init' });
        this.ndiReconnectTimer = setTimeout(() => {
            this.ndiReconnectTimer = null;
            if (this.targetSource && this.targetSource !== 'None' && !this.ndiProcess) {
                this.startNDIReceiver(this.targetSource);
            }
        }, 5000);
    }

    showOverlay(commandInfo = {}) {
        if (this.ndiReconnectTimer) {
            clearTimeout(this.ndiReconnectTimer);
            this.ndiReconnectTimer = null;
        }
        this.targetSource = null;
        this.displayMode = 'overlay';
        this.currentSource = 'None';

        this.launchDisplayKiosk();

        setTimeout(() => {
            this.broadcastToDisplay({ type: `show-${this.displayMode}` });
            const killPr = this.killNdiReceiver();
            if (!killPr) console.log('************ NDI RECEIVER process NOT terminated!');
            this.saveState(commandInfo);
            this.sendStatusToServer();
            // wait 5 seconds to ensure display is launched, to ensure a smooth fade in of the overlay
            setTimeout(() => {
                this.broadcastToDisplay({ type: `show-${this.displayMode}` });
            }, 5000);
        }, 1000);
    }

    showBlank(commandInfo = {}) {
        if (this.ndiReconnectTimer) {
            clearTimeout(this.ndiReconnectTimer);
            this.ndiReconnectTimer = null;
        }
        this.targetSource = null;
        this.displayMode = 'blank';
        this.currentSource = 'None';

        this.launchDisplayKiosk();

        setTimeout(() => {
            this.broadcastToDisplay({ type: `show-${this.displayMode}` });
            const killPr = this.killNdiReceiver();
            if (!killPr) console.log('************ NDI RECEIVER process NOT terminated!');
            this.saveState(commandInfo);
            this.sendStatusToServer();
        }, 1000);
    }

    systemShutdown() {
        consoleLog('device powering down');
        setTimeout(() => {
            exec('sudo shutdown now', (error) => {
                if (error) {
                    consoleLog('device powerdown failed', null, error);
                }
            });
        }, 1000);
    }

    systemReboot() {
        consoleLog('device rebooting...');
        setTimeout(() => {
            exec('sudo reboot', (error) => {
                if (error) {
                    consoleLog('device reboot failed', null, error);
                }
            });
        }, 1000);
    }

    applyNetworkSettings(config) {
        consoleLog('network settings updated', config);
        const fs = require('fs');
        
        // Determine network interface (usually eth0 for wired, wlan0 for WiFi)
        const networkInterface = config.wifiSSID ? 'wlan0' : 'eth0';
        
        // Build dhcpcd.conf content
        let dhcpcdConfig = '';
        
        if (config.mode === 'static' && config.staticIP) {
            dhcpcdConfig = `
interface ${networkInterface}
static ip_address=${config.staticIP}/${config.subnet === '255.255.255.0' ? '24' : '16'}
static routers=${config.gateway || config.staticIP.replace(/\.\d+$/, '.1')}
static domain_name_servers=${config.dns || '8.8.8.8'}
`;
        }
        
        // Write dhcpcd configuration
        if (dhcpcdConfig) {
            fs.writeFileSync('/tmp/ndpi-network-config', dhcpcdConfig);
            exec('sudo tee -a /etc/dhcpcd.conf < /tmp/ndpi-network-config', (error) => {
                if (error) consoleLog('Error updating dhcpcd.conf', null, error);
            });
        }
        
        // Configure WiFi if credentials provided
        if (config.wifiSSID && config.wifiPassword) {
            const wpaConfig = `
network={
    ssid="${config.wifiSSID}"
    psk="${config.wifiPassword}"
}
`;
            fs.writeFileSync('/tmp/ndpi-wifi-config', wpaConfig);
            exec('sudo tee -a /etc/wpa_supplicant/wpa_supplicant.conf < /tmp/ndpi-wifi-config', (error) => {
                if (error) consoleLog('Error updating wpa_supplicant.conf', null, error);
            });
        }
        
        // Restart networking
        exec(`sudo systemctl restart dhcpcd`, (error) => {
            if (error) {
                consoleLog('Error restarting dhcpcd:', null, error);
            } else {
                consoleLog('Network settings applied successfully');
                if (config.wifiSSID) {
                    exec('sudo wpa_cli -i wlan0 reconfigure');
                }
            }
        });
    }
}

// Start the client
const client = new NDPiClient();

process.on('uncaughtException', (err) => {
    console.log(' ');
    console.log(' ');
    consoleLog('UNCAUGHT EXCEPTION', null, err);
    console.log(' ');
    console.log(' ');
});
process.on('unhandledRejection', (err) => {
    console.log(' ');
    console.log(' ');
    consoleLog('UNHANDLED REJECTION', null, err);
    console.log(' ');
    console.log(' ');
});
    
process.on('SIGINT', () => { killProcess(); });
process.on('SIGTERM', () => { killProcess(); });

function killProcess() {
    if (client.mdnsService) {
        consoleLog('Terminating mdns');
        client.mdnsService.stop();
    }
    // Wait 500ms to allow mDNS to broadcast 'browser.down'
    setTimeout(() => {
        if (client.ndiProcess) {
            consoleLog('Terminating Servers');
            client.ndiProcess.kill('SIGKILL');
        }
        consoleLog('Terminating Application');
        console.log('⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻ ')
        console.log(' GOOD BYE 👋');
        console.log('⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻ ');
        console.log('⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻   ⸻ ');
        process.exit(0);
    }, 500);
}

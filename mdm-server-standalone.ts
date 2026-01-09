/**
 * Standalone MDM Server for Render/Cloud Deployment
 * 
 * This is a standalone Express server that can be deployed to:
 * - Render.com (recommended)
 * - Railway
 * - Fly.io
 * - Any Node.js hosting platform
 * 
 * The Electron app communicates with this server via REST API.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Types
// ============================================================================

interface MDMDevice {
  id: string;
  udid: string;
  serialNumber: string;
  deviceName: string;
  modelName: string;
  model: string;
  osVersion: string;
  buildVersion: string;
  productName: string;
  deviceCapacity?: number;
  availableCapacity?: number;
  batteryLevel?: number;
  wifiMac?: string;
  bluetoothMac?: string;
  isSupervised: boolean;
  enrollmentStatus: 'pending' | 'enrolled' | 'unenrolled';
  enrolledAt?: Date;
  lastCheckIn?: Date;
  pushToken?: string;
  pushMagic?: string;
}

interface MDMCommand {
  id: string;
  deviceId: string;
  commandType: string;
  payload?: Record<string, unknown>;
  status: 'pending' | 'sent' | 'acknowledged' | 'completed' | 'failed';
  createdAt: Date;
  sentAt?: Date;
  completedAt?: Date;
  response?: Record<string, unknown>;
  errorMessage?: string;
}

interface CheckInMessage {
  MessageType: string;
  Topic: string;
  UDID: string;
  Token?: string;
  PushMagic?: string;
  OSVersion?: string;
  BuildVersion?: string;
  ProductName?: string;
  SerialNumber?: string;
  DeviceName?: string;
  Model?: string;
  ModelName?: string;
}

// ============================================================================
// In-Memory Storage (Replace with database in production)
// ============================================================================

const devices = new Map<string, MDMDevice>();
const commandQueue = new Map<string, MDMCommand[]>();

// ============================================================================
// Plist Helpers
// ============================================================================

function parsePlist(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const dictMatch = xml.match(/<dict>([\s\S]*?)<\/dict>/);
  if (!dictMatch) return result;
  
  const content = dictMatch[1];
  const keyRegex = /<key>([^<]+)<\/key>\s*(<[^>]+>([^<]*)<\/[^>]+>|<(true|false)\/>)/g;
  
  let match;
  while ((match = keyRegex.exec(content)) !== null) {
    const key = match[1];
    if (match[4]) {
      result[key] = match[4] === 'true';
    } else if (match[3] !== undefined) {
      const value = match[3];
      const num = Number(value);
      result[key] = isNaN(num) ? value : num;
    }
  }
  
  return result;
}

function toPlist(obj: Record<string, unknown>): string {
  const convertValue = (value: unknown): string => {
    if (value === null || value === undefined) return '<string></string>';
    if (typeof value === 'boolean') return `<${value ? 'true' : 'false'}/>`;
    if (typeof value === 'number') {
      return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
    }
    if (typeof value === 'string') {
      return `<string>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`;
    }
    if (Array.isArray(value)) {
      return `<array>${value.map(convertValue).join('')}</array>`;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      return `<dict>${entries.map(([k, v]) => `<key>${k}</key>${convertValue(v)}`).join('')}</dict>`;
    }
    return `<string>${String(value)}</string>`;
  };
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${convertValue(obj)}
</plist>`;
}

// ============================================================================
// Express App
// ============================================================================

const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Needed for plist responses
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
}));

// Parse raw body for plist
app.use('/checkin', express.text({ type: '*/*' }));
app.use('/mdm', express.text({ type: '*/*' }));

// Parse JSON for API endpoints
app.use('/api', express.json());

// ============================================================================
// Health Check
// ============================================================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    devices: devices.size,
    pendingCommands: Array.from(commandQueue.values()).flat().filter(c => c.status === 'pending').length,
  });
});

// ============================================================================
// MDM Check-in Endpoint (Device -> Server)
// ============================================================================

app.put('/checkin', (req: Request, res: Response) => {
  try {
    const body = req.body as string;
    const message = parsePlist(body) as unknown as CheckInMessage;
    
    console.log(`[Check-in] ${message.MessageType} from ${message.UDID}`);
    
    switch (message.MessageType) {
      case 'Authenticate':
        handleAuthenticate(message, res);
        break;
      case 'TokenUpdate':
        handleTokenUpdate(message, res);
        break;
      case 'CheckOut':
        handleCheckOut(message, res);
        break;
      default:
        console.warn('Unknown check-in message type:', message.MessageType);
        res.status(400).send();
    }
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).send();
  }
});

function handleAuthenticate(message: CheckInMessage, res: Response): void {
  const device: MDMDevice = {
    id: uuidv4(),
    udid: message.UDID,
    serialNumber: message.SerialNumber || '',
    deviceName: message.DeviceName || '',
    modelName: message.ModelName || '',
    model: message.Model || '',
    osVersion: message.OSVersion || '',
    buildVersion: message.BuildVersion || '',
    productName: message.ProductName || '',
    isSupervised: false,
    enrollmentStatus: 'pending',
  };
  
  devices.set(message.UDID, device);
  console.log(`[Authenticate] Device registered: ${device.deviceName} (${device.udid})`);
  
  res.type('application/xml').send(toPlist({}));
}

function handleTokenUpdate(message: CheckInMessage, res: Response): void {
  const device = devices.get(message.UDID);
  
  if (device) {
    device.pushToken = message.Token;
    device.pushMagic = message.PushMagic;
    device.enrollmentStatus = 'enrolled';
    device.enrolledAt = new Date();
    device.lastCheckIn = new Date();
    
    devices.set(message.UDID, device);
    console.log(`[TokenUpdate] Device enrolled: ${device.deviceName} (${device.udid})`);
  }
  
  res.type('application/xml').send(toPlist({}));
}

function handleCheckOut(message: CheckInMessage, res: Response): void {
  const device = devices.get(message.UDID);
  
  if (device) {
    device.enrollmentStatus = 'unenrolled';
    devices.set(message.UDID, device);
    console.log(`[CheckOut] Device unenrolled: ${device.deviceName} (${device.udid})`);
  }
  
  res.type('application/xml').send(toPlist({}));
}

// ============================================================================
// MDM Command Endpoint (Device -> Server for commands)
// ============================================================================

app.put('/mdm', (req: Request, res: Response) => {
  try {
    const body = req.body as string;
    const response = parsePlist(body) as { Status: string; UDID: string; CommandUUID?: string; [key: string]: unknown };
    
    console.log(`[MDM] ${response.Status} from ${response.UDID}`);
    
    const device = devices.get(response.UDID);
    if (!device) {
      res.status(401).send();
      return;
    }
    
    device.lastCheckIn = new Date();
    
    if (response.Status === 'Idle') {
      // Device is idle, send next command if available
      const nextCommand = getNextCommand(response.UDID);
      
      if (nextCommand) {
        const commandRequest = buildCommandRequest(nextCommand);
        nextCommand.status = 'sent';
        nextCommand.sentAt = new Date();
        
        console.log(`[MDM] Sending command: ${nextCommand.commandType}`);
        res.type('application/xml').send(toPlist(commandRequest));
      } else {
        res.type('application/xml').send(toPlist({}));
      }
    } else if (response.Status === 'Acknowledged') {
      // Command acknowledged
      processCommandResponse(response.UDID, response);
      
      // Send next command
      const nextCommand = getNextCommand(response.UDID);
      if (nextCommand) {
        const commandRequest = buildCommandRequest(nextCommand);
        nextCommand.status = 'sent';
        nextCommand.sentAt = new Date();
        res.type('application/xml').send(toPlist(commandRequest));
      } else {
        res.type('application/xml').send(toPlist({}));
      }
    } else {
      res.type('application/xml').send(toPlist({}));
    }
  } catch (err) {
    console.error('MDM error:', err);
    res.status(500).send();
  }
});

function getNextCommand(udid: string): MDMCommand | undefined {
  const commands = commandQueue.get(udid) || [];
  return commands.find(cmd => cmd.status === 'pending');
}

function buildCommandRequest(command: MDMCommand): Record<string, unknown> {
  return {
    CommandUUID: command.id,
    Command: {
      RequestType: command.commandType,
      ...command.payload,
    },
  };
}

function processCommandResponse(udid: string, response: Record<string, unknown>): void {
  const commands = commandQueue.get(udid) || [];
  const command = commands.find(cmd => cmd.id === response.CommandUUID);
  
  if (command) {
    command.status = 'completed';
    command.completedAt = new Date();
    command.response = response;
    console.log(`[MDM] Command completed: ${command.commandType}`);
  }
}

// ============================================================================
// Enrollment Profile Endpoint
// ============================================================================

app.get('/enroll', (_req: Request, res: Response) => {
  const serverUrl = process.env.MDM_SERVER_URL || `https://${_req.headers.host}`;
  const orgName = process.env.ORG_NAME || 'Organization';
  const topic = process.env.APNS_TOPIC || 'com.apple.mgmt.External.placeholder';
  
  const profile = generateEnrollmentProfile(serverUrl, orgName, topic);
  
  res.type('application/x-apple-aspen-config');
  res.set('Content-Disposition', 'attachment; filename="enrollment.mobileconfig"');
  res.send(profile);
});

function generateEnrollmentProfile(serverUrl: string, orgName: string, topic: string): string {
  const profileUUID = uuidv4().toUpperCase();
  const mdmPayloadUUID = uuidv4().toUpperCase();
  
  const profile = {
    PayloadType: 'Configuration',
    PayloadVersion: 1,
    PayloadIdentifier: `com.${orgName.toLowerCase().replace(/\s+/g, '')}.mdm.enrollment`,
    PayloadUUID: profileUUID,
    PayloadDisplayName: `${orgName} MDM Enrollment`,
    PayloadDescription: `Enroll this device in ${orgName} device management`,
    PayloadOrganization: orgName,
    PayloadScope: 'System',
    PayloadRemovalDisallowed: false,
    PayloadContent: [
      {
        PayloadType: 'com.apple.mdm',
        PayloadVersion: 1,
        PayloadIdentifier: `com.${orgName.toLowerCase().replace(/\s+/g, '')}.mdm`,
        PayloadUUID: mdmPayloadUUID,
        PayloadDisplayName: 'MDM Profile',
        PayloadDescription: 'Configures device management',
        PayloadOrganization: orgName,
        Topic: topic,
        ServerURL: `${serverUrl}/mdm`,
        CheckInURL: `${serverUrl}/checkin`,
        AccessRights: 8191, // All rights
        CheckOutWhenRemoved: true,
        ServerCapabilities: ['com.apple.mdm.per-user-connections'],
      },
    ],
  };
  
  return toPlist(profile as unknown as Record<string, unknown>);
}

// ============================================================================
// REST API for Electron App
// ============================================================================

// Get all devices
app.get('/api/devices', (_req: Request, res: Response) => {
  res.json(Array.from(devices.values()));
});

// Get device by UDID
app.get('/api/devices/:udid', (req: Request, res: Response) => {
  const device = devices.get(req.params.udid);
  if (device) {
    res.json(device);
  } else {
    res.status(404).json({ error: 'Device not found' });
  }
});

// Queue a command for a device
app.post('/api/devices/:udid/commands', (req: Request, res: Response) => {
  const { udid } = req.params;
  const { commandType, payload } = req.body;
  
  const device = devices.get(udid);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  
  const command: MDMCommand = {
    id: uuidv4().toUpperCase(),
    deviceId: udid,
    commandType,
    payload,
    status: 'pending',
    createdAt: new Date(),
  };
  
  const commands = commandQueue.get(udid) || [];
  commands.push(command);
  commandQueue.set(udid, commands);
  
  console.log(`[API] Command queued: ${commandType} for ${device.deviceName}`);
  
  res.json(command);
});

// Get commands for a device
app.get('/api/devices/:udid/commands', (req: Request, res: Response) => {
  const commands = commandQueue.get(req.params.udid) || [];
  res.json(commands);
});

// Query device information
app.post('/api/devices/:udid/query', (req: Request, res: Response) => {
  const { udid } = req.params;
  const queries = req.body.queries || [
    'UDID', 'DeviceName', 'OSVersion', 'BuildVersion', 'ModelName', 'Model',
    'ProductName', 'SerialNumber', 'DeviceCapacity', 'AvailableDeviceCapacity',
    'BatteryLevel', 'WiFiMAC', 'BluetoothMAC', 'IsSupervised',
  ];
  
  const command: MDMCommand = {
    id: uuidv4().toUpperCase(),
    deviceId: udid,
    commandType: 'DeviceInformation',
    payload: { Queries: queries },
    status: 'pending',
    createdAt: new Date(),
  };
  
  const commands = commandQueue.get(udid) || [];
  commands.push(command);
  commandQueue.set(udid, commands);
  
  res.json(command);
});

// Lock device
app.post('/api/devices/:udid/lock', (req: Request, res: Response) => {
  const { udid } = req.params;
  const { message, phoneNumber } = req.body;
  
  const command: MDMCommand = {
    id: uuidv4().toUpperCase(),
    deviceId: udid,
    commandType: 'DeviceLock',
    payload: { Message: message, PhoneNumber: phoneNumber },
    status: 'pending',
    createdAt: new Date(),
  };
  
  const commands = commandQueue.get(udid) || [];
  commands.push(command);
  commandQueue.set(udid, commands);
  
  res.json(command);
});

// ============================================================================
// Agent Reporting API (Lightweight device agent reports)
// ============================================================================

interface AgentReport {
  reportId: string;
  reportedAt: string;
  organizationId: string;
  serialNumber: string;
  hardwareUUID: string;
  deviceName: string;
  modelName: string;
  modelIdentifier: string;
  marketingModelName?: string;  // Human-friendly model name like "MacBook Pro 14-inch (M4 Pro, 2024)"
  chipType: string;
  processorName: string;
  processorCores: number;
  memorySize: string;
  memorySizeBytes: number;
  storageTotalGB: number;
  storageAvailableGB: number;
  storageType: string;
  displayInfo: string;
  osName: string;
  osVersion: string;
  osBuild: string;
  osInstallDate?: string;
  lastBootTime?: string;
  ipAddress?: string;
  macAddress?: string;
  wifiMacAddress?: string;
  hostname: string;
  batteryLevel?: number;
  batteryHealth?: string;
  batteryChargingStatus?: string;
  firewallEnabled?: boolean;
  filevaultEnabled?: boolean;
  sipEnabled?: boolean;
  gatekeeperEnabled?: boolean;
  currentUser: string;
  lastLoginTime?: string;
}

// Store agent reports (keyed by serial number)
const agentReports = new Map<string, AgentReport & { lastReportedAt: Date }>();

// Receive agent report
app.post('/api/agent/report', (req: Request, res: Response) => {
  try {
    const report = req.body as AgentReport;
    
    if (!report.serialNumber || !report.hardwareUUID) {
      res.status(400).json({ error: 'Missing required fields: serialNumber or hardwareUUID' });
      return;
    }
    
    // Store the report
    agentReports.set(report.serialNumber, {
      ...report,
      lastReportedAt: new Date(),
    });
    
    console.log(`[Agent] Report received from ${report.deviceName} (${report.serialNumber})`);
    console.log(`        Model: ${report.modelName} | OS: ${report.osName} ${report.osVersion}`);
    console.log(`        IP: ${report.ipAddress || 'N/A'} | User: ${report.currentUser}`);
    
    res.status(201).json({ 
      success: true, 
      message: 'Report received',
      reportId: report.reportId,
    });
  } catch (err) {
    console.error('Agent report error:', err);
    res.status(500).json({ error: 'Failed to process report' });
  }
});

// Get all agent reports
app.get('/api/agent/reports', (_req: Request, res: Response) => {
  const reports = Array.from(agentReports.values());
  res.json(reports);
});

// Get agent report by serial number
app.get('/api/agent/reports/:serialNumber', (req: Request, res: Response) => {
  const report = agentReports.get(req.params.serialNumber);
  if (report) {
    res.json(report);
  } else {
    res.status(404).json({ error: 'Report not found' });
  }
});

// Serve the agent Swift file for download
app.get('/agent/GraceFMAgent.swift', (_req: Request, res: Response) => {
  const agentCode = '// Download from: https://mdm.gracefm.org/agent/GraceFMAgent.swift\n' +
    '// See installation instructions at: https://mdm.gracefm.org/agent/install\n' +
    '// This endpoint serves the actual agent code from the repository\n';
  res.type('text/plain').send(agentCode);
});

// Agent version check endpoint (for auto-updates)
app.get('/api/agent/version', (_req: Request, res: Response) => {
  res.json({
    version: '1.0.0',
    buildNumber: 1,
    downloadUrl: 'https://mdm.gracefm.org/agent/download',
    releaseNotes: 'Initial release with device reporting capabilities.',
    mandatory: false,
  });
});

// Agent download endpoint
app.get('/agent/download', (_req: Request, res: Response) => {
  // Redirect to the latest DMG download
  res.redirect('https://github.com/jersilb1400/MDM-Server/releases/latest/download/GraceFMAgent-Installer.dmg');
});

// Agent installation instructions page
app.get('/agent/install', (_req: Request, res: Response) => {
  const html = '<!DOCTYPE html>' +
    '<html>' +
    '<head>' +
    '  <title>Grace Fellowship Device Agent</title>' +
    '  <style>' +
    '    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #f5f5f7; }' +
    '    .card { background: white; border-radius: 12px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 20px; }' +
    '    h1 { color: #1d1d1f; }' +
    '    h2 { color: #424245; margin-top: 0; }' +
    '    code { background: #f0f0f0; padding: 2px 8px; border-radius: 4px; font-family: monospace; }' +
    '    pre { background: #1d1d1f; color: #fff; padding: 20px; border-radius: 8px; overflow-x: auto; }' +
    '    .btn { display: inline-block; background: #0071e3; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin-right: 10px; }' +
    '    .btn:hover { background: #0077ed; }' +
    '    .btn-secondary { background: #424245; }' +
    '    .steps { counter-reset: step; }' +
    '    .steps li { counter-increment: step; margin-bottom: 15px; }' +
    '  </style>' +
    '</head>' +
    '<body>' +
    '  <div class="card">' +
    '    <h1>Grace Fellowship Device Agent</h1>' +
    '    <p>A lightweight agent that reports device information to the Network Inventory Scanner.</p>' +
    '    <a href="/agent/GraceFMAgent.swift" class="btn" download>Download Agent</a>' +
    '    <a href="https://github.com/jersilb1400/MDM-Server" class="btn btn-secondary">View on GitHub</a>' +
    '  </div>' +
    '  <div class="card">' +
    '    <h2>Quick Install (macOS)</h2>' +
    '    <p>Open Terminal and run:</p>' +
    '    <pre>curl -sSL https://mdm.gracefm.org/agent/GraceFMAgent.swift -o GraceFMAgent.swift\nswift GraceFMAgent.swift</pre>' +
    '  </div>' +
    '  <div class="card">' +
    '    <h2>Manual Installation</h2>' +
    '    <ol class="steps">' +
    '      <li>Download GraceFMAgent.swift using the button above</li>' +
    '      <li>Open Terminal and navigate to the download folder</li>' +
    '      <li>Run: <code>swift GraceFMAgent.swift</code></li>' +
    '      <li>Or compile: <code>swiftc -O -o GraceFMAgent GraceFMAgent.swift</code></li>' +
    '    </ol>' +
    '  </div>' +
    '  <div class="card">' +
    '    <h2>Options</h2>' +
    '    <ul>' +
    '      <li><code>--local</code> - Run locally without sending to server</li>' +
    '    </ul>' +
    '    <pre>swift GraceFMAgent.swift --local</pre>' +
    '  </div>' +
    '</body>' +
    '</html>';
  res.type('text/html').send(html);
});

// ============================================================================
// Error Handler
// ============================================================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// Start Server
// ============================================================================

const PORT = process.env.PORT || 8443;

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    MDM Server Started                       ║
╠════════════════════════════════════════════════════════════╣
║  Port: ${String(PORT).padEnd(52)}║
║  Enrollment: https://your-domain/enroll                    ║
║  Check-in:   https://your-domain/checkin                   ║
║  Commands:   https://your-domain/mdm                       ║
║  API:        https://your-domain/api/*                     ║
╚════════════════════════════════════════════════════════════╝
  `);
});

export default app;

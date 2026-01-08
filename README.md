# MDM Server

Standalone MDM (Mobile Device Management) Server for Apple devices.

## Features

- Apple MDM protocol support (check-in, commands)
- Device enrollment via configuration profile
- REST API for device management
- Command queue system

## Deployment

This server is configured for deployment on Render.com.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 8443 |
| `ORG_NAME` | Organization name | Organization |
| `MDM_SERVER_URL` | Public server URL | Auto-detected |
| `APNS_TOPIC` | Apple Push Notification topic | Required for push |
| `ALLOWED_ORIGINS` | CORS allowed origins | * |

### Endpoints

- `GET /health` - Health check
- `GET /enroll` - Download enrollment profile
- `PUT /checkin` - Device check-in (MDM protocol)
- `PUT /mdm` - Device commands (MDM protocol)
- `GET /api/devices` - List enrolled devices
- `POST /api/devices/:udid/commands` - Queue command
- `POST /api/devices/:udid/lock` - Lock device
- `POST /api/devices/:udid/query` - Query device info

## Development

```bash
npm install
npm run dev
```

## Production

```bash
npm run build
npm start
```

# Server Bootstrap Baseline

## Startup
- Entry point initializes EnvConfig
- Registers DBContainer instance into tsyringe container
- Builds AutomatorServer(container, config).setup()
- Starts express listen(PORT)

## AutomatorServer.setup()
- appConfig(app)
- register EnvConfig if not already registered
- register Worker singleton
- resolve Authenticator and get auth middleware function
- mount resources with route prefixes, applying auth middleware at mount-time
- worker initialization is controlled by DB settings (WorkerSettingsDAO)

## Process handlers
- Attach unhandledRejection and uncaughtException logging
import dotenv from "dotenv";
dotenv.config();

export class EnvConfig {
    public readonly clientUrl: string;
    public readonly envStage: string = process.env.ENV_STAGE || "dev";
    public readonly jwtSecret: string;
    public readonly localNgrokUrl: string;
    public readonly masterApiKey: string;
    public readonly serverUrl: string;
    public readonly askZoeServerUrl: string;

    constructor() {
        this.clientUrl = process.env.VITE_ASKZACK_CLIENT_URL!;
        this.serverUrl = process.env.VITE_ASKZACK_SERVER_URL!;
        this.localNgrokUrl = process.env.LOCAL_NGROK_URL!;
        this.envStage = process.env.ENV_STAGE!;
        this.jwtSecret = process.env.JWT_SECRET!;
        this.masterApiKey = process.env.MASTER_API_KEY!;
        this.askZoeServerUrl = process.env.VITE_ASKZOE_SERVER_URL!;
    }
}
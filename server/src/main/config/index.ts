import express, {Express} from "express";
import cors from "cors";
import logger from "morgan";
import cookieParser from "cookie-parser";

const CLIENT_URL = process.env["VITE_ASKZACK_CLIENT_URL"];

console.log("CLIENT_URL", CLIENT_URL);

// Middleware configuration
export const appConfig = (app: Express) => {
    app.set("trust proxy", 1);

    app.use(
        cors({
            origin: function (origin, callback) {
                if (!origin) return callback(null, true); // allow curl/Postman
                return callback(null, true); // allow all
            },
            credentials: true,
            exposedHeaders: ['New-Token'],
        })
    );

    app.use(logger("dev"));
    app.use(express.json());
    app.use(express.urlencoded({extended: false}));
    app.use(cookieParser());
};

// Optional reusable CORS middleware if needed elsewhere
export const corsMiddleware = cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true
});
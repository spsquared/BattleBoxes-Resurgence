// handles the authentication and then hands over to HostManager instance when joining games

import bodyParser from 'body-parser';
import { Express, RequestHandler } from 'express';

import config from '@/common/config';
import Logger, { NamedLogger } from '@/common/log';

import { SessionTokenHandler } from './cryptoUtil';
import { AccountOpResult, Database } from '../common/database';
import { GameHostManager } from './hostRunner';

/**
 * Ravioli function to segment client networking (loggin in, joining games, viewing accounts, etc.)
 */
export const addClientRoutes = (expapp: Express, db: Database, hosts: GameHostManager, extLog: Logger) => {
    const app = expapp;
    const database = db;
    const hostManager = hosts;
    const logger = new NamedLogger(extLog, 'ClientHandlers');

    const accountOpToHttpCode = (stat: AccountOpResult): number => {
        switch (stat) {
            case AccountOpResult.SUCCESS: return 200;
            case AccountOpResult.ALREADY_EXISTS: return 409;
            case AccountOpResult.NOT_EXISTS: return 404;
            case AccountOpResult.INCORRECT_CREDENTIALS: return 403;
            case AccountOpResult.ERROR: return 500;
        }
    };

    // authentication
    const authTokens = new SessionTokenHandler<string>();
    const sessionTokens = new SessionTokenHandler<string>();
    const authentication: RequestHandler = (req, res, next) => {
        // don't want to block login request
        if (req.method == 'POST' && (req.url == '/login' || req.url == '/signup')) next();
        else if (typeof req.cookies.sessToken == 'string' && sessionTokens.tokenExists(req.cookies.sessToken)) {
            sessionTokens.extendTokenExpiration(req.cookies.sessToken, config.sessionExpireTime * 60);
            next();
        } else if (typeof req.cookies.authToken == 'string' && authTokens.tokenExists(req.cookies.authToken)) {
            const sessToken = sessionTokens.createToken(authTokens.tokenData(req.cookies.authToken)!, config.sessionExpireTime * 60);
            res.cookie('sessToken', sessToken, {
                httpOnly: true,
                sameSite: 'none',
                secure: true
            });
            next();
        } else res.sendStatus(401);
    };
    const checkValidCreds = (username: string, password: string) => {
        return typeof username == 'string' && username.length >= 3 && username.length <= 16 && /^[a-z0-9\-_]*$/.test(username) && typeof password == 'string' && password.length > 0 && password.length <= 128
    };
    app.get('/loginTest', authentication, (req, res) => {
        // can only reach if logged in, also used to check if logged in
        res.sendStatus(200);
    });
    app.post('/login', authentication, bodyParser.json(), async (req, res) => {
        if (req.body == null || !checkValidCreds(req.body.username, req.body.password)) {
            logger.debug(`/login validation failed: recieved ${JSON.stringify(req.body)}`);
            res.sendStatus(400);
            return;
        }
        const stat = await database.checkAccount(req.body.username, req.body.password);
        if (stat == AccountOpResult.SUCCESS) {
            const authToken = authTokens.createToken(req.body.username, config.tokenExpireTime * 60);
            res.cookie('authToken', authToken, {
                expires: new Date(authTokens.tokenExpiration(authToken)!),
                httpOnly: true,
                sameSite: 'none',
                secure: true
            });
            logger.info(`${req.body.username} logged in`);
        }
        res.sendStatus(accountOpToHttpCode(stat));
    });
    app.post('/signup', authentication, bodyParser.json(), async (req, res) => {
        if (req.body == null || !checkValidCreds(req.body.username, req.body.password)) {
            logger.debug(`/signup validation failed: recieved ${JSON.stringify(req.body)}`);
            res.sendStatus(400);
            return;
        }
        const stat = await database.createAccount(req.body.username, req.body.password);
        if (stat == AccountOpResult.SUCCESS) {
            const authToken = authTokens.createToken(req.body.username, config.tokenExpireTime * 60);
            res.cookie('authToken', authToken, {
                expires: new Date(authTokens.tokenExpiration(authToken)!),
                httpOnly: true,
                sameSite: 'none',
                secure: true
            });
            logger.info(`${req.body.username} signed up`);
        }
        res.sendStatus(accountOpToHttpCode(stat));
    });
    app.post('/logout', async (req, res) => {
        res.clearCookie('authToken', {
            httpOnly: true,
            sameSite: 'none',
            secure: true
        });
        res.clearCookie('sessToken', {
            httpOnly: true,
            sameSite: 'none',
            secure: true
        });
        res.sendStatus(200);
    });

    // creating/joining games
    app.get('/games/gameList', authentication, (req, res) => {
        const games = hostManager.getHosts(true).map((host) => ({
            id: host.id,
            host: host.hostUser,
            options: host.options
        }));
        res.json(games);
    });
    app.post('/games/joinGame/:gameId', authentication, async (req, res) => {
        const host = hostManager.getGame(req.params.gameId);
        if (host === undefined) res.sendStatus(404);
        else if (authTokens.tokenExists(req.cookies.authToken)) {
            const authCode = await host.addPlayer(authTokens.tokenData(req.cookies.authToken)!);
            if (authCode !== null) res.json(authCode);
            else res.sendStatus(500);
        } else res.sendStatus(500);
    });
    app.post('/games/createGame', authentication, bodyParser.json(), (req, res) => {

    });
};
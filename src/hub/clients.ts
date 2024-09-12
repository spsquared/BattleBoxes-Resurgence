// handles the authentication and then hands over to HostManager instance when joining games

import bodyParser from 'body-parser';
import { Express, RequestHandler } from 'express';

import config from '@/config';
import Logger, { NamedLogger } from '@/common/log';

import { SessionTokenHandler } from './cryptoUtil';
import { AccountOpResult, Database } from '../common/database';
import { GameHostManager } from './hostRunner';
import { validateRecaptcha } from './recaptcha';

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
            const sessToken = sessionTokens.createToken(authTokens.getTokenData(req.cookies.authToken)!, config.sessionExpireTime * 60);
            res.cookie('sessToken', sessToken, {
                httpOnly: true,
                sameSite: 'none',
                secure: true
            });
            next();
        } else res.sendStatus(401);
    };
    const captchaCheck: RequestHandler = async (req, res, next) => {
        if (req.body == null || typeof req.body.captcha != 'string') {
            logger.debug(`reCAPTCHA validation failed: recieved ${JSON.stringify(req.body)}`);
            res.sendStatus(400);
            return;
        }
        const recaptchaResponse = await validateRecaptcha(req.body.captcha, req.ip ?? 'UNKNOWN IP');
        if (recaptchaResponse instanceof Error) {
            logger.handleError('reCAPTCHA verification failed:', recaptchaResponse);
            res.sendStatus(500);
        } else if (recaptchaResponse == undefined || recaptchaResponse.success !== true || recaptchaResponse.score < 0.8) {
            logger.info('reCAPTCHA verification failed:');
            logger.debug(JSON.stringify(recaptchaResponse), true);
            res.sendStatus(422);
        } else {
            if (config.debugMode) {
                logger.debug('reCAPTCHA verification successful:');
                logger.debug(JSON.stringify(recaptchaResponse), true);
            }
            next();
        }
    };

    const recentSignups = new Set<string>();
    const checkValidCreds = (username: string, password: string) => {
        return typeof username == 'string' && username.length >= 3 && username.length <= 16 && /^[a-z0-9\-_]*$/.test(username) && typeof password == 'string' && password.length > 0 && password.length <= 128
    };
    app.get('/loginTest', authentication, (req, res) => {
        // can only reach if logged in, also used to check if logged in
        res.sendStatus(200);
    });
    app.post('/login', authentication, bodyParser.json(), captchaCheck, async (req, res) => {
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
            logger.info(`${req.body.username} logged in (${req.ip ?? 'UNKNOWN IP'})`);
        }
        res.sendStatus(accountOpToHttpCode(stat));
    });
    app.post('/signup', authentication, bodyParser.json(), captchaCheck, async (req, res) => {
        if (req.body == null || !checkValidCreds(req.body.username, req.body.password)) {
            logger.debug(`/signup validation failed: recieved ${JSON.stringify(req.body)}`);
            res.sendStatus(400);
            return;
        }
        if (recentSignups.has(req.ip ?? 'UNKNOWN IP')) {
            res.sendStatus(429);
            return;
        }
        recentSignups.add(req.ip ?? 'UNKNOWN IP');
        const stat = await database.createAccount(req.body.username, req.body.password);
        if (stat == AccountOpResult.SUCCESS) {
            const authToken = authTokens.createToken(req.body.username, config.tokenExpireTime * 60);
            res.cookie('authToken', authToken, {
                expires: new Date(authTokens.tokenExpiration(authToken)!),
                httpOnly: true,
                sameSite: 'none',
                secure: true
            });
            logger.info(`${req.body.username} signed up (${req.ip})`);
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
    setInterval(() => recentSignups.clear(), 30000);

    // spaghetti verification
    const formatsMatch = (user: any, expected: any) => {
        // hopefully not susceptible to DOS attack?
        try {
            const stack: [any, any, string | number, string | number][] = [];
            for (let i in expected) stack.push([expected, user, i, i]);
            while (stack.length > 0) {
                const curr = stack.pop()!;
                const expectVal = curr[0][curr[2]];
                const userVal = curr[1][curr[3]];
                if (typeof expectVal == 'object' && expectVal != null) {
                    // check all the properties within
                    for (let i in expectVal) stack.push([expectVal, userVal, i, i]);
                } else if (Array.isArray(expectVal)) {
                    // check the format of each index of userVal matches the first index of expectVal
                    if (!Array.isArray(userVal)) return false;
                    for (let i in userVal) stack.push([expectVal, userVal, 0, i]);
                } else {
                    // check that the types are the same
                    if (typeof expectVal != typeof userVal) return false;
                }
            }
            return true;
        } catch (err) {
            logger.handleError('Error while validating input:', err);
            return false;
        }
    };

    // creating/joining games
    app.get('/games/gameList', authentication, (req, res) => {
        const games = hostManager.getGames(true).map((host) => ({
            id: host.id,
            host: host.hostUser,
            options: host.options
        }));
        res.json(games);
    });
    app.post('/games/joinGame/:gameId', authentication, async (req, res) => {
        const hostRunner = hostManager.getGame(req.params.gameId);
        if (hostRunner === undefined) res.sendStatus(404);
        else if (authTokens.tokenExists(req.cookies.authToken)) {
            const username = authTokens.getTokenData(req.cookies.authToken)!;
            const authCode = await hostRunner.addPlayer(username);
            if (authCode !== null) res.json(authCode);
            else res.sendStatus(500);
            logger.info(`${username} joined game ${hostRunner.id}`);
        } else res.sendStatus(500);
    });
    app.post('/games/createGame', authentication, bodyParser.json(), captchaCheck, async (req, res) => {
        if (req.body == null || !formatsMatch(req.body, {
            maxPlayers: 0,
            aiPlayers: 0,
            public: true,
        }) || req.body.aiPlayers >= req.body.maxPlayers - 1 || req.body.maxPlayers > 8 || req.body.maxPlayers < 2 || req.body.aiPlayers < 0) {
            res.sendStatus(400);
            return;
        }
        if (authTokens.tokenExists(req.cookies.authToken)) {
            const username = authTokens.getTokenData(req.cookies.authToken)!;
            const hostRunner = hostManager.createGame(username, req.body);
            const authCode = await hostRunner.addPlayer(username);
            if (typeof authCode != 'string') res.sendStatus(accountOpToHttpCode(authCode));
            else res.json({ id: hostRunner.id, authCode: authCode });
            logger.info(`${username} created game ${hostRunner.id}`);
        } else res.sendStatus(500);
    });
};
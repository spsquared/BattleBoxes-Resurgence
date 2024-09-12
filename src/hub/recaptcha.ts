import https from 'https';

export interface RecaptchaResponse {
    success: boolean
    score: number
    action: string
    challenge_ts: number
    hostname: string
    error_codes: Array<'missing-input-secret' | 'invalid-input-secret' | 'missing-input-response' | 'invalid-input-response' | 'bad-request' | 'timeout-or-duplicate'>
}
/**
 * Verify a reCAPTCHA token using Google's servers.
 * @param {string} token User-supplied token to validate
 * @param {string} ip User (remote) ip
 * @returns Server response or error (if one occured during request)
 */
export const validateRecaptcha = async (token: string, ip: string): Promise<RecaptchaResponse | Error> => {
    // error handling is jank
    try {
        return await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'www.google.com',
                path: `/recaptcha/api/siteverify`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }, (res) => {
                if (res.statusCode == 200) {
                    res.on('error', (err) => reject(`HTTPS ${req.method} response error: ${err.message}`));
                    let chunks: Buffer[] = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () => {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    });
                } else {
                    reject(`HTTPS ${req.method} response returned status ${res.statusCode}`);
                }
            });
            req.on('error', (err) => {
                reject(`HTTPS ${req.method} request error: ${err.message}`);
            });
            req.write(`secret=${encodeURIComponent(process.env.RECAPTCHA_SECRET ?? '')}&response=${encodeURIComponent(token)}&remoteip=${encodeURIComponent(ip ?? '::1')}`);
            req.end();
        });
    } catch (err) {
        return new Error('' + err);
    }
};
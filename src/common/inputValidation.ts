export const validateStructure = <T>(user: any, expected: T) => {
    // hopefully not susceptible to DOS attack?
    try {
        const stack: [any, any, string | number, string | number][] = [];
        for (let i in expected) stack.push([expected, user, i, i]);
        while (stack.length > 0) {
            const curr = stack.pop()!;
            const expectVal = curr[0][curr[2]];
            const userVal = curr[1][curr[3]];
            if (Array.isArray(expectVal)) {
                // check the format of each index of userVal matches the first index of expectVal
                if (!Array.isArray(userVal)) return false;
                for (let i in userVal) stack.push([expectVal, userVal, 0, i]);
            } else if (typeof expectVal == 'object' && expectVal != null) {
                // check all the properties within
                for (let i in expectVal) stack.push([expectVal, userVal, i, i]);
            } else {
                // check that the types are the same
                if (typeof expectVal != typeof userVal) return false;
            }
        }
        return true;
    } catch (err) {
        return false;
    }
};
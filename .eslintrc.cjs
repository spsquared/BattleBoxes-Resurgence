/* eslint-env node */
require('@rushstack/eslint-patch/modern-module-resolution')

module.exports = {
  root: true,
  'extends': [
    'eslint:recommended',
  ],
  parserOptions: {
    ecmaVersion: 'latest'
  },
  rules: {
    "no-async-promise-executor": "off",
    "no-constant-condition": "off"
  }
}

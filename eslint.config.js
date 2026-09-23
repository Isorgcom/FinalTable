module.exports = [
  {
    ignores: ['coverage/**', 'data/**', 'node_modules/**', 'public/vendor/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      parserOptions: {
        ecmaFeatures: {
          globalReturn: true,
        },
      },
      globals: {
        AudioContext: 'readonly',
        CSS: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        prompt: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        io: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        setImmediate: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        window: 'readonly',
        THREE: 'readonly',
        Avatars: 'readonly',
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
      },
    },
    rules: {
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'error',
      'no-self-assign': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
];

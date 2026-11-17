import type { CodegenConfig } from '@graphql-codegen/cli';

// Types are generated from the LIVE endpoint: the Language enum is built from the
// catalog at upstream startup, so a checked-in schema file can lag behind.
const config: CodegenConfig = {
  schema: 'https://termennetwerk-api.netwerkdigitaalerfgoed.nl/graphql',
  documents: ['src/upstream/*.graphql'],
  generates: {
    'src/generated/': {
      preset: 'client',
      presetConfig: { fragmentMasking: false },
      config: { useTypeImports: true, enumsAsTypes: true, importExtension: '.js' },
    },
  },
};

export default config;

const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);
const mobileNodeModules = path.resolve(projectRoot, 'node_modules');
const rootNodeModules = path.resolve(projectRoot, '../../node_modules');
const blockedPaths = [path.resolve(projectRoot, '../../packages')];

config.resolver.blockList = blockedPaths.map(
	(blockedPath) =>
		new RegExp(
			`${blockedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/[^/]+\\/node_modules(?:\\/.*)?`,
		),
);
config.resolver.nodeModulesPaths = [mobileNodeModules, rootNodeModules];
config.resolver.extraNodeModules = {
	...(config.resolver.extraNodeModules ?? {}),
	react: path.resolve(mobileNodeModules, 'react'),
	'react-dom': path.resolve(mobileNodeModules, 'react-dom'),
	'react-native': path.resolve(mobileNodeModules, 'react-native'),
	'use-sync-external-store': path.resolve(mobileNodeModules, 'use-sync-external-store'),
	zod: path.resolve(rootNodeModules, 'zod'),
	zustand: path.resolve(mobileNodeModules, 'zustand'),
};

module.exports = config;

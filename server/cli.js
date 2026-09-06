#!/usr/bin/env node

const path = require("node:path");
const { TokenStore } = require("./auth");

function usage() {
    console.log(`Usage:
  npm run token -- create <label>
  npm run token -- list
  npm run token -- revoke --id <token-id>
  npm run token -- revoke --label <label>

Storage is selected by ANIMA_DATA_ROOT (default: ./data). Raw tokens are
printed only by create and are never shown by list or revoke.`);
}

function dataRootFromArgs(args) {
    const index = args.indexOf("--data-root");
    if (index === -1) {
        return path.resolve(
            process.env.ANIMA_DATA_ROOT || path.join(__dirname, "data"),
        );
    }
    const value = args[index + 1];
    if (!value) throw new Error("--data-root requires a directory");
    args.splice(index, 2);
    return path.resolve(value);
}

function optionValue(args, name) {
    const index = args.indexOf(name);
    if (index === -1) return null;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
    }
    args.splice(index, 2);
    return value;
}

async function main(argv = process.argv.slice(2)) {
    const args = [...argv];
    const command = args.shift();
    if (!command || command === "help" || command === "--help" || command === "-h") {
        usage();
        return;
    }

    const dataRoot = dataRootFromArgs(args);
    const store = new TokenStore(path.join(dataRoot, "tokens.json"));

    if (command === "create") {
        const explicitLabel = optionValue(args, "--label");
        const label = explicitLabel || args.join(" ").trim();
        if (!label) throw new Error("create requires a label");
        const created = await store.create(label);
        console.log(`id: ${created.id}`);
        console.log(`label: ${created.label}`);
        console.log(`createdAt: ${created.createdAt}`);
        console.log(`token: ${created.token}`);
        console.log("Save this token now; it will not be displayed again.");
        return;
    }

    if (command === "list") {
        if (args.length > 0) throw new Error("list does not accept positional arguments");
        const users = store.list();
        if (users.length === 0) {
            console.log("No tokens.");
            return;
        }
        for (const user of users) {
            console.log(
                `${user.id}\t${user.label}\t${user.status}\t${user.createdAt}${
                    user.revokedAt ? `\trevokedAt=${user.revokedAt}` : ""
                }`,
            );
        }
        return;
    }

    if (command === "revoke") {
        const id = optionValue(args, "--id");
        const label = optionValue(args, "--label");
        if (id && label) throw new Error("use either --id or --label, not both");
        const positional = args.join(" ").trim();
        if ((id || label) && positional) {
            throw new Error("revoke received an unexpected positional argument");
        }
        const result = await store.revoke(
            id ? { id } : label ? { label } : { id: positional },
        );
        if (!result) {
            console.error("Token record not found.");
            process.exitCode = 1;
            return;
        }
        console.log(`revoked: ${result.id}\t${result.label}\t${result.revokedAt}`);
        return;
    }

    throw new Error(`unknown token command: ${command}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`token command failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main, usage };

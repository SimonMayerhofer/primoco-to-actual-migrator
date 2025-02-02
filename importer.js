import * as api from "@actual-app/api";
import fs from "fs";
import csv from "csv-parser";
import dotenv from "dotenv";
import crypto from "crypto";
import { parse, format, isAfter } from "date-fns";
import he from "he"; // HTML entity decoder
const { decode } = he; // Extract decode function for use
import chardet from "chardet";
import iconv from "iconv-lite";
import { Readable } from "stream";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const SERVER_URL = process.env.SERVER_URL;
const ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD;
const SYNC_ID = process.env.SYNC_ID;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
const CSV_FILE_PATH = process.env.CSV_FILE_PATH;
const MARK_CLEARED = process.env.MARK_CLEARED === "true";
const FORCE_DUPLICATES = process.env.FORCE_DUPLICATES === "true";
const DEBUG = process.env.DEBUG === "true";

function parseDate(dateString) {
	try {
		// Parse date in "DD.MM.YYYY" format
		const parsedDate = parse(dateString, "dd.MM.yyyy", new Date());
		// Format as "YYYY-MM-DD"
		return format(parsedDate, "yyyy-MM-dd");
	} catch (error) {
		console.warn(`❗ Invalid date format detected: ${dateString}`);
		return null;
	}
}

/**
 * Primoco wrongly encodes characters when importing data.
 * This function decodes the text to fix the issue.
 * Additionally it decodes HTML entities and trims whitespace.
 */
function cleanData(text) {
	if (!text) return "";

	try {
		let fixedText = text;

		// Step 1: Replace known Latin-1 misencoded characters
		const encodingFixes = {
			"Ã¤": "ä", "Ã¶": "ö", "Ã¼": "ü", "ÃŸ": "ß",
			"Ã„": "Ä", "Ã–": "Ö", "Ãœ": "Ü",
			"Ã©": "é", "Ã¨": "è", "Ã´": "ô", "Ãª": "ê",
			"Ã€": "À", "Ã¡": "á", "Ã¢": "â", "Ã£": "ã",
			"Ã±": "ñ", "Ã§": "ç"
		};

		for (const [wrong, correct] of Object.entries(encodingFixes)) {
			fixedText = fixedText.replace(new RegExp(wrong, "g"), correct);
		}

		// Step 2: Decode any HTML entities (e.g., &gt; → >)
		fixedText = he.decode(fixedText.trim());
		return fixedText;
	} catch (error) {
		console.warn(`❗ Error decoding text: ${text}`, error);
		return text.trim(); // Ensure at least trimming happens
	}
}

async function loadCSV() {
	let transactions = [];
	let accounts = new Set();
	let categories = new Set();
	let importedIdMap = new Map();
	let detectedSeparator = ";"; // Default separator
	let skipFirstRow = false;

	console.log(`Reading CSV from: ${CSV_FILE_PATH}`);

	return new Promise((resolve, reject) => {
		// Read the first line manually
		fs.readFile(CSV_FILE_PATH, (err, data) => {
			if (err) {
				console.error(`❌ Error reading file: ${err.message}`);
				return reject(err);
			}

			// Detect encoding
			const encoding = chardet.detect(data);
			console.log(`✔ Detected file encoding: ${encoding}`);

			let content;
			if (encoding.includes("UTF-16")) {
				console.log(`✔ Detected ${encoding}, converting to UTF-8...`);
				content = iconv.decode(Buffer.from(data), encoding.toLowerCase());
			} else if (encoding.includes("ISO-8859") || encoding.includes("Windows-1252")) {
				console.log(`✔ Detected ${encoding}, converting to UTF-8...`);
				content = iconv.decode(Buffer.from(data), "windows-1252"); // Fix Windows encoding issues
			} else if (encoding.includes("UTF-8") && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
				console.log("✔ UTF-8 BOM detected, stripping...");
				content = data.slice(3).toString("utf-8"); // Strip BOM
			} else {
				console.log("✔ Assuming UTF-8 encoding...");
				content = data.toString("utf-8");
			}

			const lines = content.split("\n");
			if (lines.length > 0 && lines[0].startsWith("sep=")) {
				detectedSeparator = lines[0].split("=")[1].trim(); // Extract separator
				console.log(`✔ Detected CSV separator: '${detectedSeparator}'`);
				skipFirstRow = true;
			} else {
				console.log(`✔ No 'sep=' row found. Using default separator: '${detectedSeparator}'`);
			}

			const readableStream = Readable.from(Buffer.from(content, "utf-8").toString()); // Create a stream from the decoded content

			// Now, process the CSV with the correct separator
			readableStream
				.pipe(csv({
					separator: detectedSeparator,
					skipLines: skipFirstRow ? 1 : 0, // Skip the first line if it's `sep=`
					//headers: skipFirstRow ? lines[1].split(";") : lines[0].split(";"),
					mapHeaders: ({ header }) => header.trim(),
				}))
				.on("data", (row) => {
					if (typeof row["Date"] === "undefined") {
						return;
					}

					//DEBUG && console.log(`CSV Headers: ${Object.keys(row).join(", ")}`);
					//DEBUG && console.log(`Raw Row Data: ${JSON.stringify(row)}`);

					// Parse and check date
					let formattedDate = parseDate(row["Date"]);
					if (!formattedDate || isAfter(parse(row["Date"], "dd.MM.yyyy", new Date()), new Date())) {
						console.warn(`❗ Skipping future transaction: ${row["Date"]}`);
						return;
					}

					let entryType = row["Entry Type"].toLowerCase();
					let value = Math.round(parseFloat(row["Value"].replace(",", ".") || "0") * 100); // Convert to cents
					let categoryName = cleanData(row["Category"]);
					let person = cleanData(row["Person"]);
					let accountName = cleanData(row["Account"]);
					let counterAccount = cleanData(row["Counter Account"]);
					let group = cleanData(row["Group"]);
					let note = cleanData(row["Note"]);

					if (accountName) accounts.add(accountName);
					if (counterAccount) accounts.add(counterAccount);

					// Add category to set if it doesn't exist
					if (categoryName && ![...categories].some(cat => cat.name === categoryName && cat.is_income === (entryType === "income"))) {
						categories.add({ name: categoryName, is_income: entryType === "income" });
					}

					const payee_name = counterAccount || (
						person ? `👤 ${person} ` : "" +
						group ? `👥 ${group} ` : ""
					);

					// Create a unique id by hashing the entire row's original data
					const baseImportedId = crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");

					let uniqueImportedId = baseImportedId; // Default: no suffix

					// Track duplicate imported_id occurrences
					if (importedIdMap.has(baseImportedId)) {
						const existingEntries = importedIdMap.get(baseImportedId);
						const duplicateIndex = existingEntries.length; // First duplicate gets `-1`, second `-2`, etc.

						if (FORCE_DUPLICATES) {
							uniqueImportedId = `${baseImportedId}-${duplicateIndex}`;
						}

						existingEntries.push({ ...row, imported_id: uniqueImportedId });
					} else {
						importedIdMap.set(baseImportedId, [{ ...row, imported_id: baseImportedId }]);
					}

					transactions.push({
						date: formattedDate || "",
						amount: value,
						category: categoryName || "",
						payee_name: payee_name || "",
						notes: note || "",
						type: entryType || "",
						acctName: accountName || "",
						imported_id: uniqueImportedId,
					});
				})
				.on("end", () => {
					console.log(`✅ Total Accounts Found: ${accounts.size}`);
					console.log(`✅ Total Categories Found: ${categories.size}`);
					console.log(`✅ Total Transactions Found: ${transactions.length}`);
					resolve({ transactions, accounts, categories, importedIdMap });
				})
				.on("error", (err) => {
					console.error(`❌ CSV Read Error: ${err.message}`);
					reject(err);
				});
		});
	});
}

async function importAccounts(accounts, accountIdMap) {
	// Fetch existing accounts
	const existingAccounts = await api.getAccounts();
	const existingAccountNames = new Set(existingAccounts.map(acc => acc.name));

	return Promise.all(
		[...accounts].map(async (name) => {
			if (existingAccountNames.has(name)) {
				// Account already exists, retrieve its ID
				const existingAccount = existingAccounts.find(acc => acc.name === name);
				accountIdMap.set(name, existingAccount.id);
				DEBUG && console.log(`✔ Account already exists: ${name} (ID: ${existingAccount.id})`);
			} else {
				// Create new account
				const id = await api.createAccount({ name });
				accountIdMap.set(name, id);
				console.log(`✔ Created new account: ${name} (ID: ${id})`);
			}
		})
	);
}

async function importCategories(categories, categoryIdMap, transactions) {
	// Fetch existing category groups
	const existingGroups = await api.getCategoryGroups();
	let importedGroup = existingGroups.find(group => group.name === "Imported");
	let incomeGroup = existingGroups.find(group => group.is_income === true); // Get the existing income group

	DEBUG && console.log("Existing Category Groups:", existingGroups);

	// If "Imported" group doesn't exist, create it
	if (!importedGroup) {
		console.log("Creating 'Imported' category group...");
		const groupId = await api.createCategoryGroup({ name: "Imported", is_income: false });
		importedGroup = { id: groupId, name: "Imported" };
		console.log(`✔ Created 'Imported' category group (ID: ${groupId})`);
	} else {
		DEBUG && console.log(`✔ Found existing 'Imported' category group (ID: ${importedGroup.id})`);
	}

	// Fetch existing categories
	const existingCategories = await api.getCategories();
	DEBUG && console.log("Existing Categories:", existingCategories);

	return Promise.all(
		[...categories].map(async ({ name, is_income }) => {
			const existingCategory = existingCategories.find(cat => cat.name === name && cat.is_income === is_income);
			if (existingCategory) {
				categoryIdMap.set(`${name}-${is_income ? "income" : "expense"}`, existingCategory.id);
				DEBUG && console.log(`✔ ${is_income ? "Income" : "Expense"} category already exists: ${name} (ID: ${existingCategory.id})`);
			} else {
				const id = await api.createCategory({ name, group_id: is_income ? incomeGroup.id : importedGroup.id, is_income });
				categoryIdMap.set(`${name}-${is_income ? "income" : "expense"}`, id);
				console.log(`✔ Created new ${is_income ? "income" : "expense"} category: ${name} (ID: ${id})`);
			}
		})
	);
}

async function importTransactions(transactions, accountIdMap, categoryIdMap) {
	// Fetch payees to find transfer accounts
	const payees = await api.getPayees();
	const payeesByAccount = new Map(payees.map(payee_name => [payee_name.transfer_acct, payee_name.id]));

	DEBUG && console.log("payees", payees);
	DEBUG && console.log("payeesByAccount", payeesByAccount);

	// Group transactions by account ID
	const transactionsByAccount = new Map();
	console.log("  ↳ Preparing transactions...");

	for (const transaction of transactions) {
		const acctId = accountIdMap.get(transaction.acctName);
		const categoryId = categoryIdMap.get(`${transaction.category}-${transaction.type}`) || null;
		const transactionId = uuidv4(); // Generate UUID for each transaction

		if (!acctId) {
			console.warn(`❗ Skipping transaction: Account '${transaction.acctName}' not found. Transaction: ${transaction.date}, ${transaction.amount}, '${transaction.category}',  '${transaction.notes}'`);
			continue;
		}

		// Ensure the account ID exists in the map
		if (!transactionsByAccount.has(acctId)) {
			transactionsByAccount.set(acctId, []);
		}

		let transactionData = {
			id: transactionId,
			date: transaction.date,
			amount: transaction.amount,
			category: categoryId,
			payee_name: transaction.payee_name,
			notes: transaction.notes,
			imported_id: transaction.imported_id, // Helps with deduplication
			cleared: MARK_CLEARED,
		};

		let mirroredTransaction = null;
		let counterAcctId = null;

		// Handle transfers
		if (transaction.type === "transfer") {
			counterAcctId = accountIdMap.get(transaction.payee_name);

			// If no counter account is found, convert the transaction to an expense
			if (!counterAcctId) {
				console.warn(`  ❗ Transfer transaction converted to Expense: No counter account found. Transaction: '${transaction.acctName}', ${transaction.date}, Amount: ${transaction.amount}, Cat: '${transaction.category}', Notes: '${transaction.notes}'`);
				transaction.type = "expense"; // Convert transfer to expense
				transaction.amount = transaction.amount * -1; // negate the amount
			} else {
				const transferPayeeId = payeesByAccount.get(counterAcctId);
				if (!transferPayeeId) {
					console.warn(`  ❗ No transfer payee found for account: '${transaction.payee_name}'. Skipping transaction. Transaction: ${transaction.date}, Amount: ${transaction.amount}, Notes: '${transaction.notes}'`);
					continue;
				}
				transactionData.payee = transferPayeeId; // Assign the correct transfer payee
				transactionData.payee_name = null; // Prevent payee from being identified as a new payee
				transactionData.category = null; // Transfers should not have a category
				transactionData.amount = transactionData.amount * -1; // Invert, so money flow is correct

				// Create a mirrored transaction for the counter account
				const mirroredTransactionId = uuidv4(); // UUID for mirrored transaction
				transactionData.transfer_id = mirroredTransactionId;

				mirroredTransaction = {
					id: mirroredTransactionId,
					date: transaction.date,
					amount: transaction.amount, // Mirror amount for the other account
					category: null, // Transfers do not have categories
					payee: payeesByAccount.get(acctId), // Reverse the payee name
					notes: transaction.notes,
					imported_id: transaction.imported_id,
					cleared: MARK_CLEARED,
					transfer_id: transactionId, // Point back to the original
				};

				if (!transactionsByAccount.has(counterAcctId)) {
					transactionsByAccount.set(counterAcctId, []);
				}
			}
		}

		transactionsByAccount.get(acctId).push(transactionData);

		if (mirroredTransaction) {
			transactionsByAccount.get(counterAcctId).push(mirroredTransaction);
		}
	}

	console.log("\n  ↳ Importing transactions...");
	// Suppress console.log output when DEBUG is off, because of huge amount by API.
	const originalConsoleLog = console.log;

	try {
		let totalImported = 0;
		let totalUpdated = 0;
		let totalErrors = 0;

		for (const [acctId, accountTransactions] of transactionsByAccount) {
			const accountName = [...accountIdMap.entries()].find(([name, id]) => id === acctId)[0] || `Unknown (${acctId})`;
			// Batch transactions in groups of 1000, to avoid network errors.
			for (let i = 0; i < accountTransactions.length; i += 1000) {
				const batch = accountTransactions.slice(i, i + 1000);
				if (batch.length > 0) {
					console.log = () => {}; // Suppress logs

					totalImported += batch.length;
					// Sync after every batch
					await api.sync();
					console.log = originalConsoleLog; // Restore logs
					console.log(
						`  ✔ Imported ${batch.length} transactions for Account '${accountName}'`
					);
				}
			}
		}
		// Final Summary
		console.log("\n✅ Import Summary:");
		console.log(`   ✔ Total Transactions Imported: ${totalImported}`);
		if (totalUpdated > 0) {
			console.log(`   ✔ Total Transactions Updated: ${totalUpdated}`);
		}
		if (totalErrors > 0) {
			console.log(`   ❌ Total Errors: ${totalErrors}`);
		}
	} finally {
		console.log = originalConsoleLog;
	}
}

async function runImport() {
	try {
		console.log("Initializing Actual API...");
		const cacheDir = './local-budgets-cache'; // Budget data will be cached locally here, in subdirectories for each file.

		// Ensure the local budget cache directory exists
		if (!fs.existsSync(cacheDir)) {
			fs.mkdirSync(cacheDir, { recursive: true });
			console.log(`✔ Created missing directory: ${cacheDir}`);
		}

		await api.init({
			dataDir: cacheDir,
			serverURL: SERVER_URL,
			password: ACTUAL_PASSWORD,
		});

		// Ensure the API is responding properly
		let budgets = await api.getBudgets();
		if (!Array.isArray(budgets) || budgets.length === 0) {
			throw new Error("Actual API connection failed: No budgets found.");
		}

		await api.downloadBudget(SYNC_ID, E2E_PASSWORD ? { password: E2E_PASSWORD } : undefined);

		console.log("\nStarting import...");
		const { transactions, accounts, categories, importedIdMap } = await loadCSV();
		const accountIdMap = new Map();
		const categoryIdMap = new Map();

		console.log("\nImporting Accounts...");
		const sortedAccounts = [...accounts].sort((a, b) => a.localeCompare(b, "de"));
		await importAccounts(sortedAccounts, accountIdMap);
		console.log("Syncing changes...");
		await api.sync();
		DEBUG && console.log("Account ID Map:", accountIdMap);

		console.log("\nImporting Categories...");
		const sortedCategories = [...categories].sort((a, b) => a.name.localeCompare(b.name, "de"));
		DEBUG && console.log("sortedCategories:", sortedCategories);
		await importCategories(sortedCategories, categoryIdMap, transactions);
		console.log("Syncing changes...");
		await api.sync();
		DEBUG && console.log("Category ID Map:", categoryIdMap);

		console.log("\nImporting Transactions in batches...");
		await importTransactions(transactions, accountIdMap, categoryIdMap);

		console.log("\nSyncing local budget file with server...");
		await api.sync();
		console.log("\nShutting down...");
		await api.shutdown();
		console.log("Import Complete!");

		// Check for duplicate imported_id occurrences
		const duplicateIds = Array.from(importedIdMap.entries()).filter(([id, rows]) => rows.length > 1);
		if (duplicateIds.length > 0) {
			if (FORCE_DUPLICATES) {
				console.warn(`\n❗ ${duplicateIds.length} duplicates forcefully imported.`);
			} else {
				console.warn(`\n❗ Warning: ${duplicateIds.length} duplicate transactions detected based on imported_id.`);
				duplicateIds.forEach(([id, rows]) => {
					console.warn(`\n${id}`);
					rows.forEach((row, index) => {
						console.warn(`    ${JSON.stringify(row)}`);
					});
				});
			}
		}
	} catch (error) {
		console.error("❌ Error in runImport:", error);
		await api.shutdown();
		process.exit(1); // Exit with an error code
	}
}

runImport().catch(console.error);

# **Priotecs MoneyControl to Actual Migrator**

## **Overview**
The **Primoco to Actual Migrator** is a importer that allows users to **import transaction data from CSV files** (exported from [Priotecs MoneyControl](https://primoco.me)) into **Actual Budget**, ensuring a seamless transition between platforms.

---

## **Installation**

### **Prerequisites**
Before using this migrator, ensure you have:
- **Node.js** installed (tested with v23).
- **Actual Budget Server** running.
- A **CSV export** from **Primoco** (https://primoco.me/app/extras/export). *Important*: You need to set your [account language](https://primoco.me/app/profile/language) to English first.

### **Clone the Repository**
```sh
git clone https://github.com/SimonMayerhofer/primoco-to-actual-migrator.git
cd primoco-to-actual-migrator
```

### **Install Dependencies**
```sh
npm install
```

---

## **Configuration**

The migrator is configured using **environment variables** stored in a `.env` file.

### **Create a `.env` File**
Create a `.env` file in the root directory and define the required values. You can copy `.env.example` and update it.


### **Environment Variable Explanation**
| Variable        | Required | Description |
|----------------|----------|-------------|
| `SERVER_URL`   | ✅ Yes | The URL where the Actual Budget server is running. |
| `ACTUAL_PASSWORD` | ✅ Yes | The password required to access your Actual Budget Server. |
| `SYNC_ID` | ✅ Yes | The unique ID of the budget file in Actual Budget where the transactions will be imported. |
| `E2E_PASSWORD` | ❌ No | If the Actual Budget file is encrypted, this password is required for decryption. |
| `CSV_FILE_PATH` | ✅ Yes | The path to the CSV file containing the transactions. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | ❌ No | If you use a self-signed certificate, set to `0`. |
| `MARK_CLEARED` | ❌ No (default: `false`) | If `true`, imported transactions will be marked as **cleared**. |
| `DEBUG` | ❌ No (default: `false`) | If `true`, additional logs will be printed to help with debugging. |

---

## **Usage**

### **Run the Import**
Once the `.env` file is configured, start the import by running:

```sh
node importer.js
```

---

## **Notes**

- This is meant as a one time import.
- Imported data is not checked for duplicates.
- Very minor differences could happen. Check your accounts. On a dataset with 9000+ transactions one account had a difference of approximately 6,00€.
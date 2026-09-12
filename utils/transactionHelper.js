const mongoose = require("mongoose");

/**
 * Execute a callback function within a MongoDB transaction.
 * Uses session.withTransaction() which automatically handles:
 *  - startTransaction
 *  - commitTransaction
 *  - abortTransaction on error
 *  - Retries on TransientTransactionError
 *  - Retries on UnknownTransactionCommitResult
 *
 * @param {Function} callback - Async function(session) to execute within transaction
 * @returns {Promise} Result of the callback function
 */
const withTransaction = async (callback) => {
  const session = await mongoose.startSession();

  try {
    const result = await session.withTransaction(callback);
    return result;
  } finally {
    // Always end the session whether transaction succeeded or failed
    session.endSession();
  }
};

/**
 * Retry a transaction on transient errors.
 * NOTE: session.withTransaction() already handles TransientTransactionError
 * and UnknownTransactionCommitResult retries internally. This wrapper exists
 * for any additional application-level errors you want to retry on.
 *
 * @param {Function} callback - Async function(session) to execute within transaction
 * @param {Number} maxRetries - Maximum number of retry attempts for app-level errors
 * @returns {Promise} Result of the callback function
 */
const retryTransaction = async (callback, maxRetries = 3) => {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await withTransaction(callback);
    } catch (error) {
      lastError = error;

      // session.withTransaction() already handles MongoDB transient errors,
      // so we only retry here on application-level transient errors if needed.
      // If you have no custom app-level retryable errors, this will just throw
      // on the first non-MongoDB-transient failure, which is correct behavior.
      const isTransientError =
        error.errorLabels &&
        (error.errorLabels.includes("TransientTransactionError") ||
          error.errorLabels.includes("UnknownTransactionCommitResult"));

      if (!isTransientError || attempt === maxRetries) {
        throw error;
      }

      // Exponential backoff before retrying
      const delay = Math.min(100 * Math.pow(2, attempt - 1), 1000);
      console.warn(
        `Transaction attempt ${attempt} failed with transient error. Retrying in ${delay}ms...`,
        error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
};

module.exports = {
  withTransaction,
  retryTransaction,
};

const axios = require("axios");

const API_URL = process.env.API_URL || "http://localhost:4000/api";

/**
 * Simplified Performance Test Suite
 * Tests critical endpoints without requiring test data generation
 */

// Helper to measure response time
async function measureResponseTime(name, requestFn) {
  const start = Date.now();
  try {
    const result = await requestFn();
    const duration = Date.now() - start;
    return {
      name,
      duration,
      success: true,
      statusCode: result.status,
      dataSize: JSON.stringify(result.data).length,
    };
  } catch (error) {
    const duration = Date.now() - start;
    return {
      name,
      duration,
      success: false,
      error: error.response?.status || error.message,
    };
  }
}

async function runTests() {
  console.log("=".repeat(70));
  console.log("PERFORMANCE TEST SUITE - SIMPLIFIED");
  console.log("=".repeat(70));
  console.log(`API URL: ${API_URL}`);
  console.log(`Started at: ${new Date().toISOString()}\n`);

  const allResults = [];

  // Test 1: Dashboard Response Times
  console.log("=== TEST 1: Dashboard Response Times ===");
  
  const dashboardTests = [
    {
      name: "Student Dashboard - Page 1 (50 students)",
      url: `${API_URL}/dashboard/students-overview?page=1&limit=50`,
    },
    {
      name: "Student Dashboard - Page 2 (50 students)",
      url: `${API_URL}/dashboard/students-overview?page=2&limit=50`,
    },
    {
      name: "Exam Dashboard - Page 1 (50 exams)",
      url: `${API_URL}/dashboard/exams-overview?page=1&limit=50`,
    },
  ];

  for (const test of dashboardTests) {
    const result = await measureResponseTime(test.name, async () => {
      return await axios.get(test.url);
    });

    const status = result.success && result.duration < 2000 ? "✓" : "✗";
    const color = result.duration < 2000 ? "\x1b[32m" : "\x1b[31m";

    console.log(
      `${status} ${result.name}: ${color}${result.duration}ms\x1b[0m ${result.success ? `(${(result.dataSize / 1024).toFixed(1)}KB)` : `ERROR: ${result.error}`}`
    );

    allResults.push(result);
  }

  // Test 2: Pagination Verification
  console.log("\n=== TEST 2: Pagination Verification ===");

  const pageSizes = [10, 25, 50, 100];
  for (const size of pageSizes) {
    const result = await measureResponseTime(
      `Pagination - ${size} items/page`,
      async () => {
        return await axios.get(
          `${API_URL}/dashboard/students-overview?page=1&limit=${size}`
        );
      }
    );

    if (result.success) {
      console.log(
        `✓ Page size ${size}: ${result.duration}ms (${(result.dataSize / 1024).toFixed(1)}KB)`
      );
    } else {
      console.log(`✗ Page size ${size}: ERROR - ${result.error}`);
    }

    allResults.push(result);
  }

  // Test 3: Concurrent Requests
  console.log("\n=== TEST 3: Concurrent Request Handling ===");
  console.log("Sending 20 concurrent requests...");

  const concurrentCount = 20;
  const startTime = Date.now();

  const concurrentPromises = Array(concurrentCount)
    .fill()
    .map((_, i) =>
      measureResponseTime(`Concurrent Request ${i + 1}`, async () => {
        return await axios.get(
          `${API_URL}/dashboard/students-overview?page=1&limit=50`
        );
      })
    );

  const concurrentResults = await Promise.all(concurrentPromises);
  const totalTime = Date.now() - startTime;

  const successful = concurrentResults.filter((r) => r.success).length;
  const avgTime =
    concurrentResults.reduce((sum, r) => sum + r.duration, 0) /
    concurrentResults.length;
  const maxTime = Math.max(...concurrentResults.map((r) => r.duration));
  const minTime = Math.min(...concurrentResults.map((r) => r.duration));

  console.log(`Results:`);
  console.log(`  Total time: ${totalTime}ms`);
  console.log(`  Successful: ${successful}/${concurrentCount}`);
  console.log(`  Failed: ${concurrentCount - successful}/${concurrentCount}`);
  console.log(`  Average response time: ${avgTime.toFixed(0)}ms`);
  console.log(`  Min response time: ${minTime}ms`);
  console.log(`  Max response time: ${maxTime}ms`);

  const concurrentStatus =
    successful === concurrentCount && avgTime < 2000 ? "✓" : "✗";
  console.log(
    `\n${concurrentStatus} Concurrent test: ${successful === concurrentCount ? "PASSED" : "FAILED"}`
  );

  allResults.push(...concurrentResults);

  // Test 4: Memory Stability (100 consecutive requests)
  console.log("\n=== TEST 4: Memory Stability Test ===");
  console.log("Making 100 consecutive requests...");

  const memBefore = process.memoryUsage();
  const stabilityResults = [];

  for (let i = 0; i < 100; i++) {
    const result = await measureResponseTime(`Request ${i + 1}`, async () => {
      return await axios.get(
        `${API_URL}/dashboard/students-overview?page=1&limit=50`
      );
    });
    stabilityResults.push(result);

    if ((i + 1) % 20 === 0) {
      const memCurrent = process.memoryUsage();
      console.log(
        `  ${i + 1}/100 requests - Heap: ${(memCurrent.heapUsed / 1024 / 1024).toFixed(2)}MB`
      );
    }
  }

  const memAfter = process.memoryUsage();

  const stabilitySuccessful = stabilityResults.filter((r) => r.success).length;
  const stabilityAvgTime =
    stabilityResults.reduce((sum, r) => sum + r.duration, 0) /
    stabilityResults.length;

  console.log(`\nMemory Usage:`);
  console.log(
    `  Before: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)}MB`
  );
  console.log(`  After:  ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)}MB`);
  console.log(
    `  Diff:   ${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(2)}MB`
  );
  console.log(`  Successful requests: ${stabilitySuccessful}/100`);
  console.log(`  Average response time: ${stabilityAvgTime.toFixed(0)}ms`);

  const memoryGrowth = memAfter.heapUsed - memBefore.heapUsed;
  const memoryStatus = memoryGrowth < 50 * 1024 * 1024 ? "✓" : "✗";

  console.log(
    `\n${memoryStatus} Memory test: ${memoryGrowth < 50 * 1024 * 1024 ? "PASSED" : "WARNING - High memory growth"}`
  );

  allResults.push(...stabilityResults);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("TEST SUMMARY");
  console.log("=".repeat(70));

  const totalTests = allResults.length;
  const passedTests = allResults.filter(
    (t) => t.success && t.duration < 2000
  ).length;
  const avgResponseTime =
    allResults.reduce((sum, r) => sum + r.duration, 0) / totalTests;

  console.log(`Total tests: ${totalTests}`);
  console.log(`Passed: ${passedTests}`);
  console.log(`Failed: ${totalTests - passedTests}`);
  console.log(`Success rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);
  console.log(`Average response time: ${avgResponseTime.toFixed(0)}ms`);

  console.log(`\nCompleted at: ${new Date().toISOString()}`);
  console.log("=".repeat(70));

  // Exit with appropriate code
  process.exit(passedTests === totalTests ? 0 : 1);
}

// Run tests
runTests().catch((error) => {
  console.error("\n✗ Test suite failed:", error.message);
  process.exit(1);
});

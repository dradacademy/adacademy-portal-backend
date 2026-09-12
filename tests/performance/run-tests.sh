#!/bin/bash

# Performance Test Script
# Tests all critical performance scenarios

API_URL="http://localhost:4000/api"

echo "============================================================"
echo "PERFORMANCE TEST SUITE"
echo "============================================================"
echo "API URL: $API_URL"
echo "Started at: $(date)"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Dashboard Response Time
echo "=== TEST 1: Dashboard Response Time ==="
echo "Testing student dashboard with pagination..."

response_time=$(curl -o /dev/null -s -w '%{time_total}\n' "$API_URL/dashboard/students-overview?page=1&limit=50")
response_time_ms=$(echo "$response_time * 1000" | bc)

if (( $(echo "$response_time < 2.0" | bc -l) )); then
    echo -e "${GREEN}✓ Dashboard (Page 1): ${response_time_ms}ms - PASS${NC}"
else
    echo -e "${RED}✗ Dashboard (Page 1): ${response_time_ms}ms - FAIL (>2s)${NC}"
fi

response_time2=$(curl -o /dev/null -s -w '%{time_total}\n' "$API_URL/dashboard/students-overview?page=2&limit=50")
response_time2_ms=$(echo "$response_time2 * 1000" | bc)

if (( $(echo "$response_time2 < 2.0" | bc -l) )); then
    echo -e "${GREEN}✓ Dashboard (Page 2): ${response_time2_ms}ms - PASS${NC}"
else
    echo -e "${RED}✗ Dashboard (Page 2): ${response_time2_ms}ms - FAIL (>2s)${NC}"
fi

# Test 2: Exam Dashboard
echo ""
echo "=== TEST 2: Exam Dashboard Response Time ==="

response_time3=$(curl -o /dev/null -s -w '%{time_total}\n' "$API_URL/dashboard/exams-overview?page=1&limit=50")
response_time3_ms=$(echo "$response_time3 * 1000" | bc)

if (( $(echo "$response_time3 < 2.0" | bc -l) )); then
    echo -e "${GREEN}✓ Exam Dashboard: ${response_time3_ms}ms - PASS${NC}"
else
    echo -e "${RED}✗ Exam Dashboard: ${response_time3_ms}ms - FAIL (>2s)${NC}"
fi

# Test 3: Pagination Verification
echo ""
echo "=== TEST 3: Pagination Verification ==="

# Test different page sizes
for size in 10 25 50 100; do
    response=$(curl -s "$API_URL/dashboard/students-overview?page=1&limit=$size")
    count=$(echo $response | grep -o '"students":\[' | wc -l)
    
    if [ $count -gt 0 ]; then
        echo -e "${GREEN}✓ Page size $size: Working${NC}"
    else
        echo -e "${YELLOW}⚠ Page size $size: Check response${NC}"
    fi
done

# Test 4: Multiple Concurrent Requests (Simplified)
echo ""
echo "=== TEST 4: Concurrent Request Handling ==="
echo "Sending 10 concurrent requests..."

start_time=$(date +%s.%N)

for i in {1..10}; do
    curl -s "$API_URL/dashboard/students-overview?page=1&limit=50" > /dev/null &
done

wait

end_time=$(date +%s.%N)
total_time=$(echo "$end_time - $start_time" | bc)
total_time_ms=$(echo "$total_time * 1000" | bc)

echo -e "${GREEN}✓ 10 concurrent requests completed in ${total_time_ms}ms${NC}"

# Test 5: Memory Stability (100 requests)
echo ""
echo "=== TEST 5: Memory Stability Test ==="
echo "Making 100 consecutive requests..."

start_time=$(date +%s.%N)
success_count=0

for i in {1..100}; do
    response_code=$(curl -o /dev/null -s -w '%{http_code}' "$API_URL/dashboard/students-overview?page=1&limit=50")
    
    if [ "$response_code" == "200" ]; then
        ((success_count++))
    fi
    
    if [ $((i % 20)) -eq 0 ]; then
        echo "  Progress: $i/100 requests..."
    fi
done

end_time=$(date +%s.%N)
total_time=$(echo "$end_time - $start_time" | bc)
avg_time=$(echo "$total_time / 100 * 1000" | bc)

echo ""
echo "Results:"
echo "  Total requests: 100"
echo "  Successful: $success_count"
echo "  Failed: $((100 - success_count))"
echo "  Average response time: ${avg_time}ms"

if [ $success_count -eq 100 ]; then
    echo -e "${GREEN}✓ Memory stability test: PASSED${NC}"
else
    echo -e "${RED}✗ Memory stability test: FAILED${NC}"
fi

# Summary
echo ""
echo "============================================================"
echo "TEST SUMMARY"
echo "============================================================"
echo "Completed at: $(date)"
echo ""
echo "All tests completed. Review results above."
echo "============================================================"

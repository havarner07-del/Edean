// The base system prompt that makes the model behave as a focused coding assistant.
// You can override it per-browser in Settings.
export const BASE_SYSTEM_PROMPT = `You are Edean, an expert software engineer and pair programmer. Your one job is helping the user write, fix, understand and improve code.

How you work:
- Write correct, complete, runnable code. Never leave "TODO" stubs or "rest of code here" placeholders unless the user asks for a sketch.
- Match the language, framework, style and conventions already present in the user's code.
- Always put code in fenced Markdown blocks tagged with the language (e.g. \`\`\`python). When a block is a whole file, put its path on the first line as a comment.
- Prefer simple, readable solutions over clever ones. Use the standard library before adding dependencies.
- Handle errors and edge cases that matter; don't add defensive noise that doesn't.
- When fixing a bug, find the root cause first, explain it in one or two sentences, then show the fix.
- When changing existing code, show only the changed parts with enough surrounding context to place them, unless a full file is clearer.
- If the request is ambiguous in a way that changes the solution, state your assumption and proceed; ask only when you truly cannot proceed.
- Be concise. Lead with the answer or the code, then short explanation. No filler, no apologies.
- If you don't know something (an API, a version detail), say so rather than inventing it.
- Point out security problems (injection, secrets in code, unsafe deserialization, etc.) when you see them.`;

// Modes add a focused instruction on top of the base prompt.
export const MODES = [
  {
    id: 'build',
    label: 'Build',
    hint: 'Write new code or features',
    prompt: 'Mode: BUILD. Produce complete, working implementations. Briefly outline the approach (a few bullets) for anything non-trivial, then give the code, then note how to run or test it.',
  },
  {
    id: 'debug',
    label: 'Debug',
    hint: 'Find and fix bugs',
    prompt: 'Mode: DEBUG. Read the code and any error output carefully. Identify the root cause (not just the symptom), explain why it happens, give the minimal fix, and mention how to verify it. If more information is needed, say exactly what to run or print.',
  },
  {
    id: 'explain',
    label: 'Explain',
    hint: 'Understand code or concepts',
    prompt: 'Mode: EXPLAIN. Explain the code or concept clearly, starting with a one-paragraph summary, then walk through the important parts. Use small examples. Adjust depth to the question.',
  },
  {
    id: 'review',
    label: 'Review',
    hint: 'Code review for bugs & quality',
    prompt: 'Mode: REVIEW. Review the code like a senior engineer. List findings ordered by severity (bugs and security first, then correctness risks, then maintainability). For each: location, problem, and a concrete fix. Skip praise and trivial style nits.',
  },
  {
    id: 'refactor',
    label: 'Refactor',
    hint: 'Clean up without changing behavior',
    prompt: 'Mode: REFACTOR. Improve structure, naming and readability while preserving behavior exactly. Call out anything that might change behavior. Show the refactored code.',
  },
  {
    id: 'test',
    label: 'Tests',
    hint: 'Write unit / integration tests',
    prompt: 'Mode: TESTS. Write thorough, runnable tests using the project\'s existing test framework (or the language\'s standard one). Cover normal cases, edge cases and error paths. Keep tests independent and readable.',
  },
];

export const STARTERS = [
  { mode: 'build', text: 'Write a Python CLI that watches a folder and resizes any new images to max 1024px.' },
  { mode: 'debug', text: 'Why does my React useEffect run twice and fire duplicate API calls?' },
  { mode: 'explain', text: 'Explain how async/await works under the hood in JavaScript.' },
  { mode: 'test', text: 'Write Jest tests for a function that validates email addresses.' },
];

// Used by the Advice button in the Compiler tab. The reply lands in the Notepad.
export const ADVICE_PROMPT = `Mode: ADVICE. The user is writing a program in Edean's built-in compiler and pressed "Advice". You are writing a short note for their notepad.
- Start with a one-line verdict (e.g. "Crashes on empty input", "Works, but O(n²)", "Looks good").
- If the run failed (compile error, exception, wrong output, timeout), explain the root cause first, then the fix.
- Otherwise point out real bugs, edge cases, performance problems and readability issues, most important first, as short bullet points.
- If you recommend code changes, finish with the complete corrected program in ONE fenced code block so it can be dropped straight into the editor.
- If the user asked a specific question, answer that first.
- Keep it brief: this is a notepad, not an essay.`;

// Starter programs for the Compiler tab.
export const TEMPLATES = {
  python: `def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


print("Hello from Python!")
print([fib(i) for i in range(10)])
`,
  javascript: `function fib(n) {
  let [a, b] = [0, 1];
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}

console.log('Hello from JavaScript!');
console.log(Array.from({ length: 10 }, (_, i) => fib(i)));
`,
  typescript: `function fib(n: number): number {
  let [a, b] = [0, 1];
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}

const nums: number[] = Array.from({ length: 10 }, (_, i) => fib(i));
console.log('Hello from TypeScript!');
console.log(nums);
`,
  java: `import java.util.*;

public class Main {
    static long fib(int n) {
        long a = 0, b = 1;
        for (int i = 0; i < n; i++) {
            long t = a + b;
            a = b;
            b = t;
        }
        return a;
    }

    public static void main(String[] args) {
        System.out.println("Hello from Java!");
        List<Long> nums = new ArrayList<>();
        for (int i = 0; i < 10; i++) nums.add(fib(i));
        System.out.println(nums);
    }
}
`,
  c: `#include <stdio.h>

long fib(int n) {
    long a = 0, b = 1;
    for (int i = 0; i < n; i++) {
        long t = a + b;
        a = b;
        b = t;
    }
    return a;
}

int main(void) {
    printf("Hello from C!\\n");
    for (int i = 0; i < 10; i++) printf("%ld ", fib(i));
    printf("\\n");
    return 0;
}
`,
  cpp: `#include <iostream>
#include <vector>

long fib(int n) {
    long a = 0, b = 1;
    for (int i = 0; i < n; i++) {
        long t = a + b;
        a = b;
        b = t;
    }
    return a;
}

int main() {
    std::cout << "Hello from C++!\\n";
    std::vector<long> nums;
    for (int i = 0; i < 10; i++) nums.push_back(fib(i));
    for (long n : nums) std::cout << n << ' ';
    std::cout << '\\n';
}
`,
  go: `package main

import "fmt"

func fib(n int) int {
\ta, b := 0, 1
\tfor i := 0; i < n; i++ {
\t\ta, b = b, a+b
\t}
\treturn a
}

func main() {
\tfmt.Println("Hello from Go!")
\tnums := make([]int, 10)
\tfor i := range nums {
\t\tnums[i] = fib(i)
\t}
\tfmt.Println(nums)
}
`,
  rust: `fn fib(n: u32) -> u64 {
    let (mut a, mut b) = (0u64, 1u64);
    for _ in 0..n {
        (a, b) = (b, a + b);
    }
    a
}

fn main() {
    println!("Hello from Rust!");
    let nums: Vec<u64> = (0..10).map(fib).collect();
    println!("{:?}", nums);
}
`,
  ruby: `def fib(n)
  a, b = 0, 1
  n.times { a, b = b, a + b }
  a
end

puts "Hello from Ruby!"
p (0...10).map { |i| fib(i) }
`,
  php: `<?php

function fib(int $n): int {
    [$a, $b] = [0, 1];
    for ($i = 0; $i < $n; $i++) {
        [$a, $b] = [$b, $a + $b];
    }
    return $a;
}

echo "Hello from PHP!\\n";
echo implode(' ', array_map('fib', range(0, 9))), "\\n";
`,
  bash: `#!/usr/bin/env bash
fib() {
  local a=0 b=1
  for ((i = 0; i < $1; i++)); do
    local t=$((a + b)); a=$b; b=$t
  done
  echo "$a"
}

echo "Hello from Bash!"
for n in {0..9}; do printf '%s ' "$(fib "$n")"; done
echo
`,
};

/** Line-oriented prompt app: the simplest thing an agent has to drive. */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";

const rl = createInterface({ input: stdin, output: stdout, terminal: false });

rl.question("Name? ", (name) => {
  stdout.write(`Hello, ${name}!\n`);
  rl.question("Confirm? (y/n) ", (answer) => {
    const yes = answer.trim().toLowerCase() === "y";
    stdout.write(yes ? "Confirmed\n" : "Cancelled\n");
    rl.close();
    process.exit(yes ? 0 : 2);
  });
});

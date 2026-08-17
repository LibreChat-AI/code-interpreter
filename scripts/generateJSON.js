const fs = require('fs');
const path = require('path');

function parseArgs(args) {
    const result = { files: [], code: 'initial' };
    for (let i = 2; i < args.length; i++) {
        if (args[i] === '--session' || args[i] === '-s') {
            result.session = args[++i];
        } else if (args[i] === '--files' || args[i] === '-f') {
            while (args[i + 1] && !args[i + 1].startsWith('-')) {
                result.files.push(args[++i]);
            }
        } else if (args[i] === '--code' || args[i] === '-c') {
            result.code = args[++i];
        } else if (args[i] === '--help' || args[i] === '-h') {
            console.log(`
Usage: node script.js [options]

Options:
  --session, -s    Session ID
  --files, -f      Additional files (name:id)
  --code, -c       Code selection (initial or followup)
  --help, -h       Show this help message
      `);
            process.exit(0);
        }
    }
    return result;
}

const argv = parseArgs(process.argv);

/**
 * @param {string} userCode
 * @returns
 */
function createRequestBody(userCode) {
    let templateCode;
    try {
        templateCode = fs.readFileSync(
            path.join(__dirname, 'template.py'),
            'utf8',
        );
    } catch (error) {
        console.error('Error reading template.py:', error);
        return;
    }

    const indentedUserCode = userCode
        .trim()
        .split('\n')
        .map(line => `    ${line}`)
        .join('\n');

    const finalCode = templateCode.replace(
        /# BEGIN USER CODE\n[\s\S]*?# END USER CODE/,
        `# BEGIN USER CODE\n${indentedUserCode}\n    # END USER CODE`,
    );

    const requestBody = {
        language: 'python',
        version: '3.14.4',
        files: [
            {
                name: 'main.py',
                content: finalCode,
            },
        ],
    };

    if (argv.session) {
        requestBody.session_id = argv.session;
    }

    if (argv.files.length > 0) {
        argv.files.forEach(file => {
            const [name, id] = file.split(':');
            requestBody.files.push({ name, id });
        });
    }

    return JSON.stringify(requestBody, null, 2);
}

const initialCode = `
import matplotlib.pyplot as plt
import numpy as np

# Original signal generation
x = np.linspace(0, 2 * np.pi, 100)
y = np.sin(x)

# Create and save the original sine wave plot
plt.figure()
plt.plot(x, y)
plt.title("Original Sine Wave")
plt.savefig("./sine_wave.png")
plt.close()

# Modify the plot data
y_modified = y * 1.5  # Amplify the sine wave

# Create a new plot with the modified data
plt.figure()
plt.plot(x, y_modified)
plt.title("Modified Sine Wave")
plt.savefig("./modified_sine_wave.png")
plt.close()
print("Modified plot saved as modified_sine_wave.png")

# Read and modify the original image
original_img = plt.imread("./sine_wave.png")
modified_img = original_img * [1, 0.8, 0.8, 1]  # Reduce green and blue channels

plt.figure()
plt.imshow(modified_img)
plt.axis('off')
plt.savefig("./tinted_sine_wave.png")
plt.close()
print("Tinted original plot saved as tinted_sine_wave.png")

print("\\nScript completed successfully")
`;

const initialCode3 = `
import matplotlib.pyplot as plt
import numpy as np

# Let's generate a random type of chart. We'll go for a radar chart showing random values.

# Number of variables
num_vars = 5

# Generate random data for the radar chart
values = np.random.randint(0, 100, num_vars)

# Compute angle each bar is centered on:
angles = np.linspace(0, 2 * np.pi, num_vars, endpoint=False).tolist()

# The plot is a circle, so complete the loop
values = np.concatenate((values, [values[0]]))
angles += angles[:1]

# Create the radar chart
fig, ax = plt.subplots(figsize=(6, 6), subplot_kw=dict(polar=True))
ax.fill(angles, values, color='b', alpha=0.25)
ax.set_yticklabels([])

# Add titles for each axis
categories = ['A', 'B', 'C', 'D', 'E']
ax.set_xticks(angles[:-1])
ax.set_xticklabels(categories)

plt.title('Random Radar Chart')
plt.show()
`;

const followupCode = `
import matplotlib.pyplot as plt
import numpy as np
from scipy.fft import fft

# Load the modified sine wave data
x = np.linspace(0, 2 * np.pi, 100)
y_modified = 1.5 * np.sin(x)  # This is the amplified sine wave from the previous script

# Perform FFT on the modified signal
fft_result = fft(y_modified)
frequencies = np.fft.fftfreq(len(x), (x[1]-x[0])/(2*np.pi))

# Plot the FFT result
plt.figure(figsize=(10, 6))
plt.plot(frequencies, np.abs(fft_result))
plt.title("FFT of Modified Sine Wave")
plt.xlabel("Frequency")
plt.ylabel("Magnitude")
plt.xlim(0, 10)  # Limit x-axis for better visibility
plt.savefig("./fft_result.png")
plt.close()

print("FFT plot saved as fft_result.png")

# Calculate and print some statistics
mean = np.mean(y_modified)
std_dev = np.std(y_modified)
max_val = np.max(y_modified)
min_val = np.min(y_modified)

print(f"\\nStatistics of the modified sine wave:")
print(f"Mean: {mean:.4f}")
print(f"Standard Deviation: {std_dev:.4f}")
print(f"Maximum Value: {max_val:.4f}")
print(f"Minimum Value: {min_val:.4f}")

print("\\nFollow-up analysis completed successfully")
`;

const selectedCode = argv.code === 'followup' ? followupCode : initialCode;
console.log(createRequestBody(selectedCode));

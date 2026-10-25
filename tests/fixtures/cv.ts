// A fictional person and CV for tests. Not based on any real person.
import type { MasterCv, ParsedCv } from "../../src/cv/master.js";

export const parsedLlm: ParsedCv = {
  name: "Dana Example",
  contact: {
    email: "dana@example.com",
    phone: "+1 555 0100",
    location: "Exampleville",
    links: ["github.com/dana-example"],
  },
  headline: "Backend Engineer (Python/APIs)",
  summary: "Backend engineer building LLM-powered services in Python and TypeScript.",
  items: [
    {
      section: "experience",
      heading: "Software Engineer",
      subheading: "Acme Analytics",
      dates: "2022 – 2024",
      bullets: [
        "Built a retrieval service in Python serving 2,000 requests per minute",
        "Cut API latency by 40% with caching",
      ],
    },
    {
      section: "education",
      heading: "M.Sc. Computer Science",
      subheading: "Example University",
      dates: "2020 – 2022",
      bullets: [],
    },
    {
      section: "skills",
      heading: "Languages",
      subheading: null,
      dates: null,
      bullets: ["Python, TypeScript, SQL"],
    },
  ],
};

export const parsedRs: ParsedCv = {
  name: "Dana Example",
  contact: { email: "dana@example.com", phone: null, location: null, links: ["dana.example.dev"] },
  headline: "Vision & Data Engineer (Imaging)",
  summary: "ML engineer working with satellite imagery and PyTorch.",
  items: [
    {
      section: "experience",
      heading: "Software Engineer",
      subheading: "Acme Analytics",
      dates: "2022 – 2024",
      bullets: ["Trained PyTorch models on 3 TB of satellite imagery"],
    },
    {
      section: "projects",
      heading: "Cloud Mask Segmentation",
      subheading: null,
      dates: "2023",
      bullets: ["U-Net cloud masking with 92% accuracy"],
    },
    {
      section: "education",
      heading: "M.Sc. Computer Science",
      subheading: "Example University",
      dates: "2020 – 2022",
      bullets: [],
    },
  ],
};

export const master: MasterCv = {
  name: "Dana Example",
  contact: {
    email: "dana@example.com",
    phone: "+1 555 0100",
    location: "Exampleville",
    links: ["github.com/dana-example", "dana.example.dev"],
  },
  variants: [
    {
      id: "backend-engineer-python",
      label: "Backend Engineer (Python/APIs)",
      headline: "Backend Engineer (Python/APIs)",
      summary: "Backend engineer building LLM-powered services in Python and TypeScript.",
    },
    {
      id: "vision-data-engineer-ima",
      label: "Vision & Data Engineer (Imaging)",
      headline: "Vision & Data Engineer (Imaging)",
      summary: "ML engineer working with satellite imagery and PyTorch.",
    },
  ],
  items: [
    {
      id: "exp-1",
      section: "experience",
      heading: "Software Engineer",
      subheading: "Acme Analytics",
      dates: "2022 – 2024",
      bullets: [
        "Built a retrieval service in Python serving 2,000 requests per minute",
        "Cut API latency by 40% with caching",
        "Trained PyTorch models on 3 TB of satellite imagery",
      ],
      variants: ["backend-engineer-python", "vision-data-engineer-ima"],
    },
    {
      id: "edu-1",
      section: "education",
      heading: "M.Sc. Computer Science",
      subheading: "Example University",
      dates: "2020 – 2022",
      bullets: [],
      variants: ["backend-engineer-python", "vision-data-engineer-ima"],
    },
    {
      id: "skl-1",
      section: "skills",
      heading: "Languages",
      subheading: null,
      dates: null,
      bullets: ["Python, TypeScript, SQL"],
      variants: ["backend-engineer-python"],
    },
    {
      id: "prj-1",
      section: "projects",
      heading: "Cloud Mask Segmentation",
      subheading: null,
      dates: "2023",
      bullets: ["U-Net cloud masking with 92% accuracy"],
      variants: ["vision-data-engineer-ima"],
    },
  ],
};

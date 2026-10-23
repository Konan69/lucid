import { createLibrary } from '@openuidev/react-lang'
import { Box, Card, Col, Divider, Form, Grid, Row, Spacer } from './layout'
import { Icon, Image } from './media'
import { Table } from './table'
import { Badge, Caption, Label, Link, List, ListItem, Text, Title } from './text'
import { Carousel } from './carousel'
import { Chart } from './chart'
import {
  Button,
  Checkbox,
  Input,
  Pressable,
  RadioGroup,
  SegmentedControl,
  Select,
  TextArea,
} from './controls'

/**
 * Every part Vivid may draw a display from, on the phone. The component names, prop schemas and
 * descriptions are the web's own (`apps/web/src/parts/library.ts`, whose parts are ported from
 * thesysdev/open-intelligent-ui); what differs is only what a display is drawn with — native
 * views, the app's own controls and presses. `library.test.ts` holds this library's spec against
 * `packages/agent/runtime/src/agents/parts.json`, the spec the model itself was prompted with, so
 * the phone's vocabulary and the model's can never drift apart.
 */
export const library = createLibrary({
  root: 'Col',
  components: [
    Col,
    Row,
    Box,
    Grid,
    Card,
    Carousel,
    Divider,
    Spacer,
    Title,
    Text,
    Caption,
    Label,
    Badge,
    Link,
    List,
    ListItem,
    Icon,
    Image,
    Table,
    Chart,
    Button,
    Pressable,
    Input,
    TextArea,
    Select,
    SegmentedControl,
    Checkbox,
    RadioGroup,
    Form,
  ],
  componentGroups: [
    {
      name: 'Layout',
      components: ['Col', 'Row', 'Box', 'Grid', 'Card', 'Carousel', 'Divider', 'Spacer'],
    },
    {
      name: 'Text',
      components: [
        'Title',
        'Text',
        'Caption',
        'Label',
        'Badge',
        'Link',
        'List',
        'ListItem',
        'Icon',
      ],
    },
    { name: 'Data and pictures', components: ['Table', 'Chart', 'Image'] },
    {
      name: 'Inputs',
      components: [
        'Button',
        'Pressable',
        'Input',
        'TextArea',
        'Select',
        'SegmentedControl',
        'Checkbox',
        'RadioGroup',
        'Form',
      ],
    },
  ],
})
